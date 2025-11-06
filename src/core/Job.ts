import { randomUUID } from 'crypto';
import type { JobJSON, JobInit, JobState } from '../types';

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BACKOFF_BASE = 2;

function toISO(d: Date | string | undefined): string | undefined {
  if (!d) return undefined;
  return typeof d === 'string' ? new Date(d).toISOString() : d.toISOString();
}

function nowISO(): string {
  return new Date().toISOString();
}

function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

export class Job implements JobJSON {
  id: string;
  command: string;
  state: JobState;
  attempts: number;
  max_retries: number;
  created_at: string;
  updated_at: string;

  run_at?: string;
  next_attempt_at?: string;
  backoff_base?: number;
  last_error?: string;

  private constructor(props: JobJSON) {
    this.id = props.id;
    this.command = props.command;
    this.state = props.state;
    this.attempts = props.attempts;
    this.max_retries = props.max_retries;
    this.created_at = props.created_at;
    this.updated_at = props.updated_at;
    this.run_at = props.run_at;
    this.next_attempt_at = props.next_attempt_at;
    this.backoff_base = props.backoff_base;
    this.last_error = props.last_error;
  }

  // Factory for new jobs
  static create(init: JobInit): Job {
    const id = init.id ?? randomUUID();
    const created = nowISO();
    const job = new Job({
      id,
      command: init.command.trim(),
      state: 'pending',
      attempts: 0,
      max_retries: init.max_retries ?? DEFAULT_MAX_RETRIES,
      created_at: created,
      updated_at: created,
      run_at: toISO(init.run_at),
      next_attempt_at: undefined,
      backoff_base: init.backoff_base ?? DEFAULT_BACKOFF_BASE,
      last_error: undefined,
    });
    job.validate();
    return job;
  }

  // Hydrate from persisted JSON
  static fromJSON(json: JobJSON): Job {
    const normalized: JobJSON = {
      ...json,
      created_at: toISO(json.created_at)!,
      updated_at: toISO(json.updated_at)!,
      run_at: toISO(json.run_at),
      next_attempt_at: toISO(json.next_attempt_at),
      backoff_base: json.backoff_base ?? DEFAULT_BACKOFF_BASE,
    };
    const job = new Job(normalized);
    job.validate();
    return job;
  }

  toJSON(): JobJSON {
    return {
      id: this.id,
      command: this.command,
      state: this.state,
      attempts: this.attempts,
      max_retries: this.max_retries,
      created_at: this.created_at,
      updated_at: this.updated_at,
      run_at: this.run_at,
      next_attempt_at: this.next_attempt_at,
      backoff_base: this.backoff_base,
      last_error: this.last_error,
    };
  }

  // Validation for invariants
  validate(): void {
    if (!this.id) throw new Error('Job.id is required');
    if (!this.command) throw new Error('Job.command is required');
    if (!['pending', 'processing', 'completed', 'failed', 'dead'].includes(this.state)) {
      throw new Error(`Invalid Job.state: ${this.state}`);
    }
    if (this.attempts < 0) throw new Error('Job.attempts cannot be negative');
    if (this.max_retries < 0) throw new Error('Job.max_retries cannot be negative');
    if ((this.backoff_base ?? DEFAULT_BACKOFF_BASE) < 1) {
      throw new Error('Job.backoff_base must be >= 1');
    }
  }

  // State helpers
  markProcessing(): void {
    if (!['pending', 'failed'].includes(this.state)) {
      throw new Error(`Cannot markProcessing from state: ${this.state}`);
    }
    this.state = 'processing';
    this.updated_at = nowISO();
  }

  markCompleted(): void {
    if (this.state !== 'processing') {
      throw new Error(`Cannot markCompleted from state: ${this.state}`);
    }
    this.state = 'completed';
    this.updated_at = nowISO();
    this.last_error = undefined;
    this.next_attempt_at = undefined;
  }

  markFailed(error: unknown): void {
    if (this.state !== 'processing') {
      throw new Error(`Cannot markFailed from state: ${this.state}`);
    }
    const errMsg =
      error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown error';
    this.attempts += 1;
    this.updated_at = nowISO();
    this.last_error = errMsg;

    if (this.attempts > this.max_retries) {
      this.state = 'dead';
      this.next_attempt_at = undefined;
      return;
    }

    const delaySec = this.getBackoffDelaySeconds(this.attempts);
    this.state = 'failed';
    this.next_attempt_at = addSeconds(new Date(), delaySec).toISOString();
  }

  // Retry logic
  isRetryable(): boolean {
    return this.attempts < this.max_retries && this.state !== 'dead' && this.state !== 'completed';
    // Note: 'failed' with attempts < max_retries is retryable when due
  }

  getBackoffDelaySeconds(attemptNumber: number): number {
    const base = this.backoff_base ?? DEFAULT_BACKOFF_BASE;
    // delay = base ^ attempts (as per spec)
    return Math.pow(base, attemptNumber);
  }

  // Scheduling helpers
  isDue(at: Date = new Date()): boolean {
    if (this.state === 'pending') {
      if (!this.run_at) return true;
      return new Date(this.run_at) <= at;
    }
    if (this.state === 'failed' && this.isRetryable()) {
      if (!this.next_attempt_at) return true; // fallback safety
      return new Date(this.next_attempt_at) <= at;
    }
    return false;
  }

  // Reset to pending (e.g., when moving back from DLQ via CLI)
  resetForRetry(options?: { keepAttempts?: boolean }): void {
    if (this.state !== 'dead' && this.state !== 'failed') {
      throw new Error(`Cannot resetForRetry from state: ${this.state}`);
    }
    if (!options?.keepAttempts) this.attempts = 0;
    this.state = 'pending';
    this.updated_at = nowISO();
    this.next_attempt_at = undefined;
    this.last_error = undefined;
  }
}

export { DEFAULT_MAX_RETRIES, DEFAULT_BACKOFF_BASE };