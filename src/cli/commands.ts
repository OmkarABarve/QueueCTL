// src/cli/commands.ts
import { Command } from 'commander';
import * as path from 'path';
import * as fs from 'fs/promises';
import { loadConfig, createStorage } from '../config/Config';
import type { Config } from '../config/Config';
import type { IStorage } from '../storage/IStorage';
import { Job } from '../core/Job';
import { CommandExecutor } from '../core/Executor';
import  DLQManager  from '../dlq/DLQManager';
import type { JobState } from '../types';

type RcShape = {
  storage?: Partial<Config['storage']>;
  worker?: Partial<Config['worker']>;
};

const RC_FILE = 'queuectl.config.json';
const PID_FILE = 'queuectl.worker.pid';

const program = new Command();
program.name('queuectl').description('QueueCTL CLI').version('0.1.0');

// ---------- helpers ----------

async function readRc(root: string): Promise<RcShape> {
  try {
    const raw = await fs.readFile(path.join(root, RC_FILE), 'utf8');
    return JSON.parse(raw) as RcShape;
  } catch {
    return {};
  }
}

async function writeRc(root: string, rc: RcShape): Promise<void> {
  const file = path.join(root, RC_FILE);
  await fs.writeFile(file, JSON.stringify(rc, null, 2) + '\n', 'utf8');
}

async function loadMergedConfig(): Promise<Config> {
  const base = loadConfig();
  const root = process.cwd();
  const rc = await readRc(root);

  return {
    storage: {
      driver: rc.storage?.driver ?? base.storage.driver,
      sqlitePath: rc.storage?.sqlitePath ?? base.storage.sqlitePath,
      jsonDir: rc.storage?.jsonDir ?? base.storage.jsonDir,
    },
    worker: {
      pollIntervalMs: rc.worker?.pollIntervalMs ?? base.worker.pollIntervalMs,
      concurrency: rc.worker?.concurrency ?? base.worker.concurrency,
    },
  };
}

async function withStorage<T>(fn: (storage: IStorage, cfg: Config) => Promise<T>): Promise<T> {
  const cfg = await loadMergedConfig();
  const storage = createStorage(cfg);
  await storage.init?.();
  try {
    return await fn(storage, cfg);
  } finally {
    storage.close?.();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writePidFile(): Promise<void> {
  const file = path.join(process.cwd(), PID_FILE);
  await fs.writeFile(file, String(process.pid), 'utf8');
}

async function readPidFile(): Promise<number | null> {
  try {
    const s = await fs.readFile(path.join(process.cwd(), PID_FILE), 'utf8');
    const pid = Number(s.trim());
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

async function removePidFile(): Promise<void> {
  try {
    await fs.unlink(path.join(process.cwd(), PID_FILE));
  } catch {
    // ignore
  }
}

// ---------- enqueue ----------

program
  .command('enqueue')
  .description('Enqueue a new job')
  .argument('<command...>', 'Command to run (quoted if necessary)')
  .option('--run-at <isoOrMs>', 'Defer execution until this time (ISO string or ms epoch)')
  .option('--max-retries <n>', 'Max retries before DLQ (default from Job)', (v) => Number(v))
  .option('--backoff-base <n>', 'Exponential backoff base (default 2)', (v) => Number(v))
  .action(async (cmdParts: string[], opts: { runAt?: string; maxRetries?: number; backoffBase?: number }) => {
    const commandStr = cmdParts.join(' ').trim();
    await withStorage(async (storage) => {
      const runAt = opts.runAt
        ? isNaN(Number(opts.runAt))
          ? new Date(opts.runAt)
          : new Date(Number(opts.runAt))
        : undefined;

      const job = Job.create({
        command: commandStr,
        max_retries: typeof opts.maxRetries === 'number' ? opts.maxRetries : undefined,
        backoff_base: typeof opts.backoffBase === 'number' ? opts.backoffBase : undefined,
        run_at: runAt,
      });

      await storage.enqueue(job);
      console.log(JSON.stringify(job.toJSON(), null, 2));
    });
  });

// ---------- list ----------

program
  .command('list')
  .description('List jobs, optionally by state')
  .option('--state <state>', "Filter by state: pending|processing|completed|failed|dead", (v) => v as JobState)
  .action(async (opts: { state?: JobState }) => {
    await withStorage(async (storage) => {
      const items = await storage.list(opts.state);
      console.log(JSON.stringify(items.map((j) => j.toJSON()), null, 2));
    });
  });

// ---------- worker commands ----------

const worker = program.command('worker').description('Worker commands');

worker
  .command('start')
  .description('Start a worker that leases jobs from storage')
  .option('--count <n>', 'Number of parallel executors', (v) => Number(v))
  .option('--concurrency <n>', 'Number of parallel executors (deprecated; use --count)', (v) => Number(v))
  .option('--poll <ms>', 'Polling interval when idle', (v) => Number(v))
  .option('--timeout <ms>', 'Per-job execution timeout (ms)', (v) => Number(v))
  .action(async (opts: { count?: number; concurrency?: number; poll?: number; timeout?: number }) => {
    await withStorage(async (storage, cfg) => {
      const numWorkers = Math.max(1, (opts.count ?? opts.concurrency ?? cfg.worker.concurrency));
      const pollMs = Math.max(1, opts.poll ?? cfg.worker.pollIntervalMs);
      const executor = new CommandExecutor({
        timeoutMs: opts.timeout,
        onOutput: (chunk, stream, job) => {
          const line = chunk.toString().trim();
          if (line) console.log(`[${job.id}] ${stream}: ${line}`);
        },
      });

      await writePidFile();

      let running = true;
      const stop = async () => {
        running = false;
        await removePidFile();
      };
      process.on('SIGINT', () => void stop());
      process.on('SIGTERM', () => void stop());
      process.on('exit', () => void removePidFile());

      async function loop(slot: number) {
        while (running) {
          const job = await storage.leaseNext(new Date());
          if (!job) {
            await sleep(pollMs);
            continue;
          }

          try {
            await executor.execute(job);
            job.markCompleted();
            await storage.update(job);
          } catch (err) {
            job.markFailed(err);
            if (job.state === 'dead') {
              await storage.moveToDLQ(job);
              console.error(`Moved to DLQ: ${job.id} (${job.last_error ?? 'unknown error'})`);
            } else {
              await storage.update(job);
              console.error(`Failed attempt ${job.attempts}/${job.max_retries}: ${job.id} — next at ${job.next_attempt_at}`);
            }
          }
        }
      }

      await Promise.all(Array.from({ length: numWorkers }, (_, i) => loop(i)));
      console.log('Worker stopped.');
    });
  });

worker
  .command('stop')
  .description(`Stop a running worker started in this cwd (via ${PID_FILE})`)
  .action(async () => {
    const pid = await readPidFile();
    if (!pid) {
      console.error('No worker PID file found.');
      process.exitCode = 1;
      return;
    }
    try {
      process.kill(pid);
      await removePidFile();
      console.log(`Sent termination to PID ${pid}`);
    } catch (e) {
      console.error(`Failed to stop PID ${pid}: ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
    }
  });

// ---------- status ----------

program
  .command('status')
  .description('Show counts per state and DLQ size')
  .action(async () => {
    await withStorage(async (storage) => {
      const [pending, processing, completed, failed, dead, dlq] = await Promise.all([
        storage.list('pending'),
        storage.list('processing'),
        storage.list('completed'),
        storage.list('failed'),
        storage.list('dead'),
        storage.listDLQ(),
      ]);
      console.log(
        JSON.stringify(
          {
            pending: pending.length,
            processing: processing.length,
            completed: completed.length,
            failed: failed.length,
            dead: dead.length,
            dlq: dlq.length,
          },
          null,
          2
        )
      );
    });
  });

// ---------- dlq commands ----------

const dlq = program.command('dlq').description('Dead Letter Queue commands');

dlq
  .command('list')
  .description('List jobs in the DLQ')
  .action(async () => {
    await withStorage(async (storage) => {
      const mgr = new DLQManager(storage);
      const items = await mgr.list();
      console.log(JSON.stringify(items.map((j) => j.toJSON()), null, 2));
    });
  });

dlq
  .command('retry')
  .description('Retry a job from the DLQ by id')
  .argument('<jobId>')
  .action(async (jobId: string) => {
    await withStorage(async (storage) => {
      const mgr = new DLQManager(storage);
      const res = await mgr.retry(jobId);
      if (!res) {
        console.error(`Job ${jobId} not found in DLQ`);
        process.exitCode = 2;
        return;
      }
      console.log(`Requeued job ${jobId}`);
    });
  });

// ---------- config get/set ----------

const configCmd = program.command('config').description('View or modify configuration');

configCmd
  .command('get')
  .description('Get current effective config (env overlaid with rc file)')
  .action(async () => {
    const cfg = await loadMergedConfig();
    console.log(JSON.stringify(cfg, null, 2));
  });

configCmd
  .command('set')
  .description('Set a config key (persists to queuectl.config.json)')
  .argument('<key>', 'Key path, e.g., storage.driver or worker.concurrency')
  .argument('<value>', 'Value (string; numbers are parsed if possible)')
  .action(async (key: string, value: string) => {
    const root = process.cwd();
    const rc = await readRc(root);

    const parts = key.split('.');
    let cursor: any = rc;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i]!;
      cursor[p] = cursor[p] ?? {};
      cursor = cursor[p];
    }
    const leaf = parts[parts.length - 1]!;
    const parsed = isNaN(Number(value)) ? value : Number(value);
    cursor[leaf] = parsed;

    await writeRc(root, rc);
    console.log(`Updated ${RC_FILE}: ${key} = ${JSON.stringify(parsed)}`);
  });

// ---------- export entry ----------

export async function runCLI(argv: string[]): Promise<void> {
  await program.parseAsync(argv, { from: 'user' });
}