// src/cli/commands.ts- CLI Wiring for Commands, while DLQ has CLI for DLQ commands like list, retry

// src/cli/commands.ts
import { Command } from 'commander';
import * as path from 'path';
import * as fs from 'fs/promises';
import { loadConfig, createStorage } from '../config/Config';
import type { Config } from '../config/Config';
import type { IStorage } from '../storage/IStorage';
import { Job } from '../core/Job';
import { CommandExecutor } from '../core/Executor';
import { DLQManager } from '../dlq/DLQManager';

type RcShape = {
  storage?: Partial<Config['storage']>;
  worker?: Partial<Config['worker']>;
};

const RC_FILE = 'queuectl.config.json';

const program = new Command();
program.name('queuectl').description('QueueCTL CLI').version('0.1.0');

// ---------- helpers ----------

async function readRc(root: string): Promise<RcShape> {
  try {
    const raw = await fs.readFile(path.join(root, RC_FILE), 'utf8');
    return JSON.parse(raw) as RcShape;
  } catch {
    return {};
  }
}

async function writeRc(root: string, rc: RcShape): Promise<void> {
  const file = path.join(root, RC_FILE);
  await fs.writeFile(file, JSON.stringify(rc, null, 2) + '\n', 'utf8');
}

async function loadMergedConfig(): Promise<Config> {
  const base = loadConfig();
  const root = process.cwd();
  const rc = await readRc(root);

  return {
    storage: {
      driver: rc.storage?.driver ?? base.storage.driver,
      sqlitePath: rc.storage?.sqlitePath ?? base.storage.sqlitePath,
      jsonDir: rc.storage?.jsonDir ?? base.storage.jsonDir,
    },
    worker: {
      pollIntervalMs: rc.worker?.pollIntervalMs ?? base.worker.pollIntervalMs,
      concurrency: rc.worker?.concurrency ?? base.worker.concurrency,
    },
  };
}

async function withStorage<T>(fn: (storage: IStorage, cfg: Config) => Promise<T>): Promise<T> {
  const cfg = await loadMergedConfig();
  const storage = createStorage(cfg);
  await storage.init?.();
  try {
    return await fn(storage, cfg);
  } finally {
    storage.close?.();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- enqueue ----------

program
  .command('enqueue')
  .description('Enqueue a new job')
  .argument('<command...>', 'Command to run (quoted if necessary)')
  .option('--run-at <isoOrMs>', 'Defer execution until this time (ISO string or ms epoch)')
  .option('--max-retries <n>', 'Max retries before DLQ (default from Job)', (v) => Number(v))
  .option('--backoff-base <n>', 'Exponential backoff base (default 2)', (v) => Number(v))
  .action(async (cmdParts: string[], opts: { runAt?: string; maxRetries?: number; backoffBase?: number }) => {
    const commandStr = cmdParts.join(' ').trim();
    await withStorage(async (storage) => {
      const runAt = opts.runAt
        ? isNaN(Number(opts.runAt))
          ? new Date(opts.runAt)
          : new Date(Number(opts.runAt))
        : undefined;

      const job = Job.create({
        command: commandStr,
        max_retries: typeof opts.maxRetries === 'number' ? opts.maxRetries : undefined,
        backoff_base: typeof opts.backoffBase === 'number' ? opts.backoffBase : undefined,
        run_at: runAt,
      });

      await storage.enqueue(job);
      console.log(JSON.stringify(job.toJSON(), null, 2));
    });
  });

// ---------- worker start ----------

program
  .command('worker')
  .description('Worker commands')
  .command('start')
  .description('Start a worker that leases jobs from storage')
  .option('--concurrency <n>', 'Number of parallel executors', (v) => Number(v))
  .option('--poll <ms>', 'Polling interval when idle', (v) => Number(v))
  .option('--timeout <ms>', 'Per-job execution timeout (ms)', (v) => Number(v))
  .action(async (opts: { concurrency?: number; poll?: number; timeout?: number }) => {
    await withStorage(async (storage, cfg) => {
      const concurrency = Math.max(1, opts.concurrency ?? cfg.worker.concurrency);
      const pollMs = Math.max(1, opts.poll ?? cfg.worker.pollIntervalMs);
      const executor = new CommandExecutor({
        timeoutMs: opts.timeout,
        onOutput: (chunk, stream, job) => {
          const line = chunk.toString().trim();
          if (line) console.log(`[${job.id}] ${stream}: ${line}`);
        },
      });

      let running = true;
      process.on('SIGINT', () => (running = false));
      process.on('SIGTERM', () => (running = false));

      async function loop(slot: number) {
        while (running) {
          const job = await storage.leaseNext(new Date());
          if (!job) {
            await sleep(pollMs);
            continue;
          }

          try {
            await executor.execute(job);
            job.markCompleted();
            await storage.update(job);
          } catch (err) {
            // Apply retry/backoff via Job; persist; or DLQ if dead
            job.markFailed(err);
            if (job.state === 'dead') {
              await storage.moveToDLQ(job);
              console.error(`Moved to DLQ: ${job.id} (${job.last_error ?? 'unknown error'})`);
            } else {
              await storage.update(job);
              console.error(`Failed attempt ${job.attempts}/${job.max_retries}: ${job.id} — next at ${job.next_attempt_at}`);
            }
          }
        }
      }

      await Promise.all(Array.from({ length: concurrency }, (_, i) => loop(i)));
      console.log('Worker stopped.');
    });
  });

// ---------- status ----------

program
  .command('status')
  .description('Show counts per state and DLQ size')
  .action(async () => {
    await withStorage(async (storage) => {
      const [pending, processing, completed, failed, dead, dlq] = await Promise.all([
        storage.list('pending'),
        storage.list('processing'),
        storage.list('completed'),
        storage.list('failed'),
        storage.list('dead'),
        storage.listDLQ(),
      ]);
      console.log(
        JSON.stringify(
          {
            pending: pending.length,
            processing: processing.length,
            completed: completed.length,
            failed: failed.length,
            dead: dead.length,
            dlq: dlq.length,
          },
          null,
          2
        )
      );
    });
  });

// ---------- dlq list (and retry via dedicated dlq.ts or here) ----------

program
  .command('dlq')
  .description('Dead Letter Queue commands')
  .command('list')
  .description('List jobs in the DLQ')
  .action(async () => {
    await withStorage(async (storage) => {
      const mgr = new DLQManager(storage);
      const items = await mgr.list();
      console.log(JSON.stringify(items.map((j) => j.toJSON()), null, 2));
    });
  });

// ---------- config get/set ----------

program
  .command('config')
  .description('View or modify configuration')
  .command('get')
  .description('Get current effective config (env overlaid with rc file)')
  .action(async () => {
    const cfg = await loadMergedConfig();
    console.log(JSON.stringify(cfg, null, 2));
  });

program
  .command('config')
  .command('set')
  .description('Set a config key (persists to queuectl.config.json)')
  .argument('<key>', 'Key path, e.g., storage.driver or worker.concurrency')
  .argument('<value>', 'Value (string; numbers are parsed if possible)')
  .action(async (key: string, value: string) => {
    const root = process.cwd();
    const rc = await readRc(root);

    // parse and assign
    const parts = key.split('.');
    let cursor: any = rc;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i]!;
      cursor[p] = cursor[p] ?? {};
      cursor = cursor[p];
    }
    const leaf = parts[parts.length - 1]!;
    const parsed = isNaN(Number(value)) ? value : Number(value);
    cursor[leaf] = parsed;

    await writeRc(root, rc);
    console.log(`Updated ${RC_FILE}: ${key} = ${JSON.stringify(parsed)}`);
  });

// ---------- export entry ----------

export async function runCLI(argv: string[]): Promise<void> {
  await program.parseAsync(argv, { from: 'user' });
}