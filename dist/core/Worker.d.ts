import { Queue } from './Queue';
import { Job } from './Job';
import type { Executor } from './Executor';
export interface WorkerOptions {
    pollIntervalMs?: number;
    concurrency?: number;
    stopOnEmpty?: boolean;
    onError?: (err: unknown, job?: Job) => void;
    name?: string;
}
export declare class Worker {
    private readonly queue;
    private readonly executor;
    private readonly opts;
    private running;
    private loops;
    private inFlight;
    constructor(queue: Queue, executor: Executor, options?: WorkerOptions);
    start(): void;
    stop(): Promise<void>;
    private runLoop;
    private sleep;
}
