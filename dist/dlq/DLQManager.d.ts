import type { IStorage } from '../storage/IStorage';
import type { Job } from '../core/Job';
declare class DLQManager {
    private readonly storage;
    constructor(storage: IStorage);
    static fromConfig(): Promise<DLQManager>;
    add(job: Job): Promise<void>;
    sweepDeadToDLQ(): Promise<number>;
    list(): Promise<Job[]>;
    retry(jobId: string): Promise<Job | null>;
    runCommand(subcmd: 'list' | 'retry', jobId?: string): Promise<Job[] | Job | null>;
    close(): void;
}
export default DLQManager;
export { DLQManager };
