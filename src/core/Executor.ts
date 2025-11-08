// src/core/Executor.ts
import type { Job } from './Job';
import { spawn, type ChildProcess } from 'child_process';

export interface Executor {
  // Run the job. Resolve on success; throw on failure so Worker can apply retry/DLQ.
  execute(job: Job): Promise<void>;
}

export interface CommandExecutorOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  // If true (default), run via system shell. You can also pass a shell path (e.g., 'bash').
  shell?: boolean | string;
  // Kill the process if it exceeds this duration (ms). Omit/0 to disable.
  timeoutMs?: number;
  // Signal used when killing long-running processes.
  killSignal?: NodeJS.Signals | number;
  // Optional output hook for streaming logs/metrics.
  onOutput?: (chunk: string, stream: 'stdout' | 'stderr', job: Job) => void;
}

export class CommandExecutor implements Executor {
  private readonly opts: Required<Pick<CommandExecutorOptions, 'shell' | 'killSignal'>> &
    Omit<CommandExecutorOptions, 'shell' | 'killSignal'>;

  constructor(options?: CommandExecutorOptions) {
    this.opts = {
      cwd: options?.cwd,
      env: options?.env,
      shell: options?.shell ?? true,
      timeoutMs: options?.timeoutMs,
      killSignal: options?.killSignal ?? 'SIGTERM',
      onOutput: options?.onOutput,
    };
  }

  async execute(job: Job): Promise<void> {
    const command = job.command.trim();
    if (!command) {
      throw new Error(`Empty command for job ${job.id}`);
    }

    const child = this.spawnShell(command, this.opts);

    // Stream output with job context
    if (this.opts.onOutput) {
      if (child.stdout) {
        child.stdout.on('data', (buf: Buffer) =>
          this.opts.onOutput!(buf.toString(), 'stdout', job)
        );
      }
      if (child.stderr) {
        child.stderr.on('data', (buf: Buffer) =>
          this.opts.onOutput!(buf.toString(), 'stderr', job)
        );
      }
    }

    const { code, signal, stderr } = await this.waitFor(child, this.opts.timeoutMs);

    if (code === 0) return;

    const sigInfo = signal ? ` (signal: ${signal})` : '';
    const errMsg = stderr?.trim() || `Command failed${sigInfo}`;
    throw new Error(`Job ${job.id} failed with exit code ${code}${sigInfo}: ${truncate(errMsg, 400)}`);
  }

  private spawnShell(cmd: string, opts: CommandExecutorOptions): ChildProcess {
    // Use spawn with shell to avoid exec buffer limits and support complex commands/pipes.
    return spawn(cmd, {
      shell: opts.shell ?? true,
      cwd: opts.cwd,
      env: opts.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  private waitFor(child: ChildProcess, timeoutMs?: number): Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }> {
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      let stderr = '';

      if (child.stderr) {
        child.stderr.on('data', (buf: Buffer) => {
          stderr += buf.toString();
        });
      }

      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        if (timer) clearTimeout(timer);
        resolve({ code, signal, stderr });
      };

      child.once('exit', onExit);
      child.once('error', () => onExit(1, null)); // treat spawn errors as failure

      if (timeoutMs && timeoutMs > 0) {
        timer = setTimeout(() => {
          try {
            child.kill(this.opts.killSignal);
          } catch {
            // ignore kill errors
          }
        }, timeoutMs);
      }
    });
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + '...';
}