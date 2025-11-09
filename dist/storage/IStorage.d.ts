import type { JobState } from '../types';
import { Job } from '../core/Job';
export interface IStorage {
    init(): Promise<void> | void;
    enqueue(job: Job): Promise<void> | void;
    update(job: Job): Promise<void> | void;
    moveToDLQ(job: Job): Promise<void> | void;
    getById(id: string): Promise<Job | null> | Job | null;
    leaseNext(at?: Date): Promise<Job | null> | Job | null;
    list(state?: JobState): Promise<Job[]> | Job[];
    listDLQ(): Promise<Job[]> | Job[];
    retryFromDLQ(id: string): Promise<Job | null> | Job | null;
    close?(): void;
}
