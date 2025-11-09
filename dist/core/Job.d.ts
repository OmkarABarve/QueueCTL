import type { JobJSON, JobInit, JobState } from '../types';
declare const DEFAULT_MAX_RETRIES = 3;
declare const DEFAULT_BACKOFF_BASE = 2;
export declare class Job implements JobJSON {
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
    private constructor();
    static create(init: JobInit): Job;
    static fromJSON(json: JobJSON): Job;
    toJSON(): JobJSON;
    validate(): void;
    markProcessing(): void;
    markCompleted(): void;
    markFailed(error: unknown): void;
    isRetryable(): boolean;
    getBackoffDelaySeconds(attemptNumber: number): number;
    isDue(at?: Date): boolean;
    resetForRetry(options?: {
        keepAttempts?: boolean;
    }): void;
}
export { DEFAULT_MAX_RETRIES, DEFAULT_BACKOFF_BASE };
