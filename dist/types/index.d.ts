export type JobState = 'pending' | 'processing' | 'completed' | 'failed' | 'dead';
export interface JobJSON {
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
}
export interface JobInit {
    id?: string;
    command: string;
    max_retries?: number;
    backoff_base?: number;
    run_at?: Date | string;
}
