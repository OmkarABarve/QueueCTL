"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Worker = void 0;
class Worker {
    constructor(queue, executor, options) {
        this.running = false;
        this.loops = [];
        this.inFlight = 0;
        this.queue = queue;
        this.executor = executor;
        this.opts = {
            pollIntervalMs: options?.pollIntervalMs ?? 500,
            concurrency: Math.max(1, options?.concurrency ?? 1),
            stopOnEmpty: options?.stopOnEmpty ?? false,
            onError: options?.onError,
            name: options?.name,
        };
    }
    start() {
        if (this.running)
            return;
        this.running = true;
        this.loops = [];
        for (let i = 0; i < this.opts.concurrency; i++) {
            this.loops.push(this.runLoop(i));
        }
    }
    // Graceful: lets in-flight job(s) finish, then resolves.
    async stop() {
        if (!this.running)
            return;
        this.running = false;
        await Promise.all(this.loops);
        this.loops = [];
    }
    async runLoop(slot) {
        const label = this.opts.name ? `${this.opts.name}#${slot}` : `worker#${slot}`;
        while (this.running) {
            // Lease next due job; dequeue marks job 'processing' to avoid duplicates.
            const job = this.queue.dequeue({ at: new Date() });
            if (!job) {
                if (this.opts.stopOnEmpty) {
                    // No work; auto-stop this loop
                    break;
                }
                await this.sleep(this.opts.pollIntervalMs);
                continue;
            }
            this.inFlight += 1;
            try {
                await this.executor.execute(job);
                // Success: finalize job
                this.queue.complete(job.id);
            }
            catch (err) {
                // Failure: apply retry/DLQ logic via Job.markFailed() and Queue.fail()
                try {
                    this.queue.fail(job.id, err);
                }
                catch (inner) {
                    // If fail transition itself throws, surface it with the original context
                    this.opts.onError?.(inner, job);
                }
                this.opts.onError?.(err, job);
            }
            finally {
                this.inFlight -= 1;
            }
        }
        // If we exited the loop due to stop(), let any already-started job finish above
        // and then return to resolve this loop promise.
    }
    sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}
exports.Worker = Worker;
//# sourceMappingURL=Worker.js.map