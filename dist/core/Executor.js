"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CommandExecutor = void 0;
const child_process_1 = require("child_process");
class CommandExecutor {
    constructor(options) {
        this.opts = {
            cwd: options?.cwd,
            env: options?.env,
            shell: options?.shell ?? true,
            timeoutMs: options?.timeoutMs,
            killSignal: options?.killSignal ?? 'SIGTERM',
            onOutput: options?.onOutput,
        };
    }
    async execute(job) {
        const command = job.command.trim();
        if (!command) {
            throw new Error(`Empty command for job ${job.id}`);
        }
        const child = this.spawnShell(command, this.opts);
        // Stream output with job context
        if (this.opts.onOutput) {
            if (child.stdout) {
                child.stdout.on('data', (buf) => this.opts.onOutput(buf.toString(), 'stdout', job));
            }
            if (child.stderr) {
                child.stderr.on('data', (buf) => this.opts.onOutput(buf.toString(), 'stderr', job));
            }
        }
        const { code, signal, stderr } = await this.waitFor(child, this.opts.timeoutMs);
        if (code === 0)
            return;
        const sigInfo = signal ? ` (signal: ${signal})` : '';
        const errMsg = stderr?.trim() || `Command failed${sigInfo}`;
        throw new Error(`Job ${job.id} failed with exit code ${code}${sigInfo}: ${truncate(errMsg, 400)}`);
    }
    spawnShell(cmd, opts) {
        // Use spawn with shell to avoid exec buffer limits and support complex commands/pipes.
        return (0, child_process_1.spawn)(cmd, {
            shell: opts.shell ?? true,
            cwd: opts.cwd,
            env: opts.env,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    }
    waitFor(child, timeoutMs) {
        return new Promise((resolve) => {
            let timer;
            let stderr = '';
            if (child.stderr) {
                child.stderr.on('data', (buf) => {
                    stderr += buf.toString();
                });
            }
            const onExit = (code, signal) => {
                if (timer)
                    clearTimeout(timer);
                resolve({ code, signal, stderr });
            };
            child.once('exit', onExit);
            child.once('error', () => onExit(1, null)); // treat spawn errors as failure
            if (timeoutMs && timeoutMs > 0) {
                timer = setTimeout(() => {
                    try {
                        child.kill(this.opts.killSignal);
                    }
                    catch {
                        // ignore kill errors
                    }
                }, timeoutMs);
            }
        });
    }
}
exports.CommandExecutor = CommandExecutor;
function truncate(s, max) {
    if (s.length <= max)
        return s;
    return s.slice(0, max - 3) + '...';
}
//# sourceMappingURL=Executor.js.map