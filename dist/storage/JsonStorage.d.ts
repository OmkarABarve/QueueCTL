import type { IStorage } from './IStorage';
import type { JobState } from '../types';
import { Job } from '../core/Job';
export interface JsonStorageOptions {
    dir: string;
    lockTimeoutMs?: number;
    retryDelayMs?: number;
}
export declare class JsonStorage implements IStorage {
    private readonly paths;
    private readonly lockTimeoutMs;
    private readonly retryDelayMs;
    constructor(options: JsonStorageOptions);
    init(): Promise<void>;
    enqueue(job: Job): Promise<void>;
    update(job: Job): Promise<void>;
    moveToDLQ(job: Job): Promise<void>;
    getById(id: string): Promise<Job | null>;
    leaseNext(at?: Date): Promise<Job | null>;
    list(state?: JobState): Promise<Job[]>;
    listDLQ(): Promise<Job[]>;
    retryFromDLQ(id: string): Promise<Job | null>;
    close(): void;
    private ensureFile;
    private readJobs;
    private writeJobs;
    private readDLQ;
    private writeDLQ;
    private withLock;
}
