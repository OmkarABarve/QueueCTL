import { Job } from './Job';
import type { JobState } from '../types';
export interface DequeueOptions {
    at?: Date;
}
export interface GetPendingOptions {
    at?: Date;
    dueOnly?: boolean;
    includeFailedRetries?: boolean;
}
export declare class Queue {
    private jobs;
    private stateOf;
    private byState;
    private insertSeq;
    private insertionOrder;
    enqueue(job: Job): void;
    dequeue(options?: DequeueOptions): Job | null;
    updateJob(updated: Job): void;
    complete(jobId: string): Job;
    fail(jobId: string, error: unknown): Job;
    requeue(jobId: string): Job;
    resetForRetry(jobId: string, options?: {
        keepAttempts?: boolean;
    }): Job;
    getById(id: string): Job | undefined;
    getPendingJobs(opts?: GetPendingOptions): Job[];
    list(state?: JobState): Job[];
    size(): number;
    private moveState;
    private requireJob;
    private effectiveDueAt;
}
