// src/types/index.ts

export type JobState = 'pending' | 'processing' | 'completed' | 'failed' | 'dead';

export interface JobJSON {
  id: string;
  command: string;
  state: JobState;
  attempts: number;
  max_retries: number;
  created_at: string;   // ISO string
  updated_at: string;   // ISO string

  // Optional but useful for scheduling/retry/observability
  run_at?: string;            // If set, don't run before this time
  next_attempt_at?: string;   // When to retry next (for failed jobs)
  backoff_base?: number;      // Exponential base for backoff; default 2
  last_error?: string;        // Last error message
}

export interface JobInit {
  id?: string;
  command: string;
  max_retries?: number;
  backoff_base?: number;
  run_at?: Date | string;
}