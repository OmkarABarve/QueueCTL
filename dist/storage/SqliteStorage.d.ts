import type { IStorage } from './IStorage';
import type { JobState } from '../types';
import { Job } from '../core/Job';
export declare class SqliteStorage implements IStorage {
    private filePath;
    private db;
    constructor(filePath: string);
    init(): void;
    enqueue(job: Job): void;
    update(job: Job): void;
    getById(id: string): Job | null;
    leaseNext(at?: Date): Job | null;
    list(state?: JobState): Job[];
    moveToDLQ(job: Job): void;
    listDLQ(): Job[];
    retryFromDLQ(id: string): Job | null;
    close(): void;
    private rowToJSON;
}
