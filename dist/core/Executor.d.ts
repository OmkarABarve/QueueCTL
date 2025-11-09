import type { Job } from './Job';
export interface Executor {
    execute(job: Job): Promise<void>;
}
export interface CommandExecutorOptions {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    shell?: boolean | string;
    timeoutMs?: number;
    killSignal?: NodeJS.Signals | number;
    onOutput?: (chunk: string, stream: 'stdout' | 'stderr', job: Job) => void;
}
export declare class CommandExecutor implements Executor {
    private readonly opts;
    constructor(options?: CommandExecutorOptions);
    execute(job: Job): Promise<void>;
    private spawnShell;
    private waitFor;
}
