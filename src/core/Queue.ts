import { Job } from './Job';
import type { JobState } from '../types';

export interface DequeueOptions {
  at?: Date; // evaluation time for scheduling/due checks
}

export interface GetPendingOptions {
  at?: Date;
  dueOnly?: boolean;                 // if true, return only due jobs
  includeFailedRetries?: boolean;    // if true, include retryable failed jobs
}

export class Queue {
  private jobs = new Map<string, Job>();
  private stateOf = new Map<string, JobState>();
  private byState: Record<JobState, Set<string>> = {
    pending: new Set(),
    processing: new Set(),
    completed: new Set(),
    failed: new Set(),
    dead: new Set(),
  };

  // Tie-breaker for FIFO among equal due times
  private insertSeq = 0;
  private insertionOrder = new Map<string, number>();

  // ---------- Core ops ----------

  enqueue(job: Job): void {
    if (this.jobs.has(job.id)) {
      throw new Error(`Job already exists: ${job.id}`);
    }
    if (!['pending'].includes(job.state)) {
      throw new Error(`Can only enqueue jobs in 'pending' state (got ${job.state})`);
    }
    this.jobs.set(job.id, job);
    this.stateOf.set(job.id, job.state);
    this.byState[job.state].add(job.id);
    this.insertionOrder.set(job.id, ++this.insertSeq);
  }

  // Lease the next due job and mark it processing to prevent duplicates
  dequeue(options?: DequeueOptions): Job | null {
    const at = options?.at ?? new Date();

    let selected: { id: string; dueAt: Date; seq: number } | null = null;

    // Consider due 'pending' and retryable 'failed'
    const consider = (id: string) => {
      const job = this.jobs.get(id);
      if (!job) return;
      if (!job.isDue(at)) return;

      const dueAt = this.effectiveDueAt(job);
      if (!dueAt) return;

      const seq = this.insertionOrder.get(id) ?? 0;
      if (!selected) {
        selected = { id, dueAt, seq };
        return;
      }
      // Earlier dueAt wins; tie-breaker by FIFO insertion order (smaller seq first)
      if (dueAt < selected.dueAt || (dueAt.getTime() === selected.dueAt.getTime() && seq < selected.seq)) {
        selected = { id, dueAt, seq };
      }
    };

    for (const id of this.byState.pending) consider(id);
    for (const id of this.byState.failed) consider(id);

    if (!selected) {
      return null;
    }

    // Ensure selected has correct type for TypeScript
    const jobId = (selected as { id: string }).id;
    const job = this.requireJob(jobId);

    // Transition to processing using Job API
    job.markProcessing();
    this.moveState(job.id, 'processing');
    return job;
  }

  // Update an existing job object (e.g., after external edits)
  updateJob(updated: Job): void {
    const existing = this.requireJob(updated.id);
    const prevState = this.stateOf.get(existing.id);
    const nextState = updated.state;

    this.jobs.set(updated.id, updated);

    if (prevState !== nextState) {
      if (prevState) this.byState[prevState].delete(updated.id);
      this.byState[nextState].add(updated.id);
      this.stateOf.set(updated.id, nextState);
    }
  }

  // ---------- State transitions (safe wrappers) ----------

  complete(jobId: string): Job {
    const job = this.requireJob(jobId);
    if (this.stateOf.get(jobId) !== 'processing') {
      throw new Error(`complete() requires 'processing' state (got ${this.stateOf.get(jobId)})`);
    }
    job.markCompleted();
    this.moveState(jobId, 'completed');
    return job;
  }

  fail(jobId: string, error: unknown): Job {
    const job = this.requireJob(jobId);
    if (this.stateOf.get(jobId) !== 'processing') {
      throw new Error(`fail() requires 'processing' state (got ${this.stateOf.get(jobId)})`);
    }
    job.markFailed(error);
    if (job.state === 'dead') {
      this.moveState(jobId, 'dead');
    } else {
      this.moveState(jobId, 'failed');
    }
    return job;
  }

  // Requeue a job back to pending (e.g., manual retry)
  requeue(jobId: string): Job {
    const job = this.requireJob(jobId);
    if (!['failed', 'processing', 'pending'].includes(job.state)) {
      throw new Error(`requeue() cannot apply from state ${job.state}`);
    }
    // Keep attempts for visibility; use resetForRetry if you want to zero them
    if (job.state === 'processing') {
      // If someone tries to requeue a leased job, return it safely
      // without calling markCompleted/markFailed.
      // Move back to pending:
      // Note: markPending keeps attempts and last_error.
      // @ts-ignore — method exists if you added it, otherwise fallback:
      if (typeof (job as any).markPending === 'function') {
        (job as any).markPending();
      } else {
        // Fallback without markPending helper
        (job as any).state = 'pending';
        (job as any).next_attempt_at = undefined;
        (job as any).updated_at = new Date().toISOString();
      }
      this.moveState(jobId, 'pending');
      return job;
    }
    // From failed -> pending
    if (typeof (job as any).markPending === 'function') {
      (job as any).markPending();
    } else {
      (job as any).state = 'pending';
      (job as any).next_attempt_at = undefined;
      (job as any).updated_at = new Date().toISOString();
    }
    this.moveState(jobId, 'pending');
    return job;
  }

  resetForRetry(jobId: string, options?: { keepAttempts?: boolean }): Job {
    const job = this.requireJob(jobId);
    job.resetForRetry(options);
    this.moveState(jobId, 'pending');
    return job;
  }

  // ---------- Queries ----------

  getById(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  getPendingJobs(opts?: GetPendingOptions): Job[] {
    const at = opts?.at ?? new Date();
    const dueOnly = opts?.dueOnly ?? false;
    const includeFailed = opts?.includeFailedRetries ?? true;

    const out: Job[] = [];
    for (const id of this.byState.pending) {
      const job = this.jobs.get(id);
      if (!job) continue;
      if (!dueOnly || job.isDue(at)) out.push(job);
    }
    if (includeFailed) {
      for (const id of this.byState.failed) {
        const job = this.jobs.get(id);
        if (!job) continue;
        if (!dueOnly || job.isDue(at)) out.push(job);
      }
    }
    // Order by effective due time, then FIFO insertion
    return out.sort((a, b) => {
      const ad = this.effectiveDueAt(a)?.getTime() ?? Number.MAX_SAFE_INTEGER;
      const bd = this.effectiveDueAt(b)?.getTime() ?? Number.MAX_SAFE_INTEGER;
      if (ad !== bd) return ad - bd;
      const as = this.insertionOrder.get(a.id) ?? 0;
      const bs = this.insertionOrder.get(b.id) ?? 0;
      return as - bs;
    });
  }

  list(state?: JobState): Job[] {
    if (!state) {
      return Array.from(this.jobs.values());
    }
    return Array.from(this.byState[state]).map((id) => this.jobs.get(id)!).filter(Boolean);
  }

  size(): number {
    return this.jobs.size;
  }

  // ---------- Internals ----------

  private moveState(id: string, next: JobState): void {
    const current = this.stateOf.get(id);
    if (current && current !== next) {
      this.byState[current].delete(id);
    }
    this.byState[next].add(id);
    this.stateOf.set(id, next);
  }

  private requireJob(id: string): Job {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Job not found: ${id}`);
    return job;
  }

  private effectiveDueAt(job: Job): Date | null {
    // For ordering: when is this job eligible to run next?
    if (job.state === 'pending') {
      return job.run_at ? new Date(job.run_at) : new Date(job.created_at);
    }
    if (job.state === 'failed' && job.isRetryable()) {
      return job.next_attempt_at ? new Date(job.next_attempt_at) : new Date();
    }
    return null; // other states aren't schedulable
    }
}