// src/storage/JsonStorage.ts
import { promises as fs } from 'fs';
import * as fscb from 'fs';
import * as path from 'path';
import type { IStorage } from './IStorage';
import type { JobJSON, JobState } from '../types';
import { Job } from '../core/Job';

type PersistedJobs = JobJSON[];
type PersistedDLQ = JobJSON[];

interface Paths {
  dir: string;
  jobs: string;
  dlq: string;
  lock: string;
}

export interface JsonStorageOptions {
  dir: string;               // directory to store files
  lockTimeoutMs?: number;    // max time to wait for lock acquisition
  retryDelayMs?: number;     // base delay between lock retries
}

export class JsonStorage implements IStorage {
  private readonly paths: Paths;
  private readonly lockTimeoutMs: number;
  private readonly retryDelayMs: number;

  constructor(options: JsonStorageOptions) {
    const dir = path.resolve(options.dir);
    this.paths = {
      dir,
      jobs: path.join(dir, 'jobs.json'),
      dlq: path.join(dir, 'dlq.json'),
      lock: path.join(dir, 'queue.lock'),
    };
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5000;
    this.retryDelayMs = options.retryDelayMs ?? 25;
  }

  async init(): Promise<void> {
    await fs.mkdir(this.paths.dir, { recursive: true });
    await this.ensureFile(this.paths.jobs, '[]\n');
    await this.ensureFile(this.paths.dlq, '[]\n');
  }

  // ---------- write paths ----------

  async enqueue(job: Job): Promise<void> {
    await this.withLock(async () => {
      const jobs = await this.readJobs();
      if (jobs.some(j => j.id === job.id)) {
        throw new Error(`Job already exists: ${job.id}`);
      }
      jobs.push(job.toJSON());
      await this.writeJobs(jobs);
    });
  }

  async update(job: Job): Promise<void> {
    await this.withLock(async () => {
      const jobs = await this.readJobs();
      const idx = jobs.findIndex(j => j.id === job.id);
      if (idx === -1) {
        throw new Error(`Job not found: ${job.id}`);
      }
      jobs[idx] = job.toJSON();
      await this.writeJobs(jobs);
    });
  }

  async moveToDLQ(job: Job): Promise<void> {
    await this.withLock(async () => {
      const [jobs, dlq] = await Promise.all([this.readJobs(), this.readDLQ()]);
      const idx = jobs.findIndex(j => j.id === job.id);
      if (idx !== -1) {
        jobs.splice(idx, 1);
      }
      dlq.push(job.toJSON());
      await Promise.all([this.writeJobs(jobs), this.writeDLQ(dlq)]);
    });
  }

  // ---------- read/lease ----------

  async getById(id: string): Promise<Job | null> {
    const jobs = await this.readJobs();
    const found = jobs.find(j => j.id === id);
    return found ? Job.fromJSON(found) : null;
  }

  // Atomically lease the next due job; marks it 'processing' to avoid duplicates
  async leaseNext(at: Date = new Date()): Promise<Job | null> {
    return await this.withLock(async () => {
      const jobs = await this.readJobs();

      // Find due jobs (pending due or failed retryable due)
      const candidates: JobJSON[] = [];
      for (const j of jobs) {
        const job = Job.fromJSON(j);
        if (job.isDue(at)) {
          candidates.push(j);
        }
      }
      if (candidates.length === 0) return null;

      // Sort by effective due time then created_at (FIFO)
      candidates.sort((a, b) => {
        const ad = effectiveDueAt(a);
        const bd = effectiveDueAt(b);
        if (ad !== bd) return ad - bd;
        return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      });

      // Take the first candidate and mark processing
      const selected = candidates[0];
      const idx = jobs.findIndex(j => j.id === selected.id);
      if (idx === -1) return null;

      const leased = { ...jobs[idx] };
      const now = new Date().toISOString();
      leased.state = 'processing';
      leased.updated_at = now;

      jobs[idx] = leased;
      await this.writeJobs(jobs);
      return Job.fromJSON(leased);
    });
  }

  // ---------- queries ----------

  async list(state?: JobState): Promise<Job[]> {
    const jobs = await this.readJobs();
    const filtered = state ? jobs.filter(j => j.state === state) : jobs;
    return filtered.map(j => Job.fromJSON(j));
  }

  async listDLQ(): Promise<Job[]> {
    const dlq = await this.readDLQ();
    return dlq.map(j => Job.fromJSON(j));
  }

  async retryFromDLQ(id: string): Promise<Job | null> {
    return await this.withLock(async () => {
      const [jobs, dlq] = await Promise.all([this.readJobs(), this.readDLQ()]);
      const idx = dlq.findIndex(j => j.id === id);
      if (idx === -1) return null;

      const payload = dlq[idx];
      dlq.splice(idx, 1);

      const job = Job.fromJSON(payload);
      job.resetForRetry({ keepAttempts: false });

      if (jobs.some(j => j.id === job.id)) {
        // replace existing if same id present
        const jdx = jobs.findIndex(j => j.id === job.id);
        jobs[jdx] = job.toJSON();
      } else {
        jobs.push(job.toJSON());
      }

      await Promise.all([this.writeJobs(jobs), this.writeDLQ(dlq)]);
      return job;
    });
  }

  close(): void {
    // no-op for file-based storage
  }

  // ---------- internals ----------

  private async ensureFile(filePath: string, initial: string): Promise<void> {
    try {
      await fs.access(filePath);
    } catch {
      await fs.writeFile(filePath, initial, 'utf8');
    }
  }

  private async readJobs(): Promise<PersistedJobs> {
    try {
      const raw = await fs.readFile(this.paths.jobs, 'utf8');
      const data = JSON.parse(raw);
      return Array.isArray(data) ? data as PersistedJobs : [];
    } catch {
      return [];
    }
  }

  private async writeJobs(jobs: PersistedJobs): Promise<void> {
    await fs.writeFile(this.paths.jobs, JSON.stringify(jobs, null, 2) + '\n', 'utf8');
  }

  private async readDLQ(): Promise<PersistedDLQ> {
    try {
      const raw = await fs.readFile(this.paths.dlq, 'utf8');
      const data = JSON.parse(raw);
      return Array.isArray(data) ? data as PersistedDLQ : [];
    } catch {
      return [];
    }
  }

  private async writeDLQ(dlq: PersistedDLQ): Promise<void> {
    await fs.writeFile(this.paths.dlq, JSON.stringify(dlq, null, 2) + '\n', 'utf8');
  }

  // Basic lock using an exclusive lock file. Retries until acquired or timeout.
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    while (true) {
      try {
        const fd = fscb.openSync(this.paths.lock, fscb.constants.O_CREAT | fscb.constants.O_EXCL | fscb.constants.O_WRONLY, 0o644);
        try {
          fscb.writeFileSync(fd, `${process.pid} ${new Date().toISOString()}`);
        } finally {
          fscb.closeSync(fd);
        }
        break; // acquired
      } catch (err: any) {
        if (err && err.code === 'EEXIST') {
          if (Date.now() - start > this.lockTimeoutMs) {
            throw new Error(`JsonStorage: failed to acquire lock within ${this.lockTimeoutMs}ms`);
          }
          await sleep(this.retryDelayMs);
          continue;
        }
        throw err;
      }
    }

    try {
      return await fn();
    } finally {
      try {
        await fs.unlink(this.paths.lock);
      } catch {
        // ignore
      }
    }
  }
}

function effectiveDueAt(j: JobJSON): number {
  const ts = j.next_attempt_at ?? j.run_at ?? j.created_at;
  return new Date(ts).getTime();
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}