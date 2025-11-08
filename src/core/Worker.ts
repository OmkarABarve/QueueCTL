// src/core/Worker.ts
import { Queue } from './Queue';
import { Job } from './Job';
import type { Executor } from './Executor';

export interface WorkerOptions {
  // How often to poll when there is no due work
  pollIntervalMs?: number;
  // Number of concurrent loops pulling and executing jobs
  concurrency?: number;
  // If true, stop automatically when no job is available at a poll tick
  stopOnEmpty?: boolean;
  // Optional hook to observe errors
  onError?: (err: unknown, job?: Job) => void;
  // Optional identifier for logging/metrics
  name?: string;
}

export class Worker {
  private readonly queue: Queue;
  private readonly executor: Executor;
  private readonly opts: Required<Pick<WorkerOptions, 'pollIntervalMs' | 'concurrency' | 'stopOnEmpty'>> & Omit<WorkerOptions, 'pollIntervalMs' | 'concurrency' | 'stopOnEmpty'>;

  private running = false;
  private loops: Promise<void>[] = [];
  private inFlight = 0;

  constructor(queue: Queue, executor: Executor, options?: WorkerOptions) {
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

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loops = [];
    for (let i = 0; i < this.opts.concurrency; i++) {
      this.loops.push(this.runLoop(i));
    }
  }

  // Graceful: lets in-flight job(s) finish, then resolves.
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    await Promise.all(this.loops);
    this.loops = [];
  }

  private async runLoop(slot: number): Promise<void> {
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
      } catch (err) {
        // Failure: apply retry/DLQ logic via Job.markFailed() and Queue.fail()
        try {
          this.queue.fail(job.id, err);
        } catch (inner) {
          // If fail transition itself throws, surface it with the original context
          this.opts.onError?.(inner, job);
        }
        this.opts.onError?.(err, job);
      } finally {
        this.inFlight -= 1;
      }
    }

    // If we exited the loop due to stop(), let any already-started job finish above
    // and then return to resolve this loop promise.
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}