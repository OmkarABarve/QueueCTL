// src/dlq/DLQManager.ts
import type { IStorage } from '../storage/IStorage';
import type { Job } from '../core/Job';
import type { JobState } from '../types';
import { loadConfig, createStorage } from '../config/Config';

 class DLQManager {
  private readonly storage: IStorage;

  constructor(storage: IStorage) {
    this.storage = storage;
  }

  static async fromConfig(): Promise<DLQManager> {
    const cfg = loadConfig();
    const storage = createStorage(cfg);
    await storage.init?.();
    return new DLQManager(storage);
  }

  // Move a job to DLQ immediately (use this when you detect a job has gone 'dead')
  async add(job: Job): Promise<void> {
    await this.storage.moveToDLQ(job);
  }

  // Sweep any persisted 'dead' jobs into the DLQ (useful if state was updated but not moved yet)
  async sweepDeadToDLQ(): Promise<number> {
    const dead: Job[] = await this.storage.list('dead' as JobState);
    let moved = 0;
    for (const j of dead) {
      await this.storage.moveToDLQ(j);
      moved++;
    }
    return moved;
  }

  // List jobs currently in DLQ
  async list(): Promise<Job[]> {
    return await this.storage.listDLQ();
  }

  // Retry a job from DLQ: removes it from DLQ, resets state to 'pending', enqueues it back
  async retry(jobId: string): Promise<Job | null> {
    return await this.storage.retryFromDLQ(jobId);
  }

  // Small helper to wire into a CLI command layer
  async runCommand(subcmd: 'list' | 'retry', jobId?: string): Promise<Job[] | Job | null> {
    if (subcmd === 'list') {
      return await this.list();
    }
    if (subcmd === 'retry') {
      if (!jobId) throw new Error('dlq retry requires <jobId>');
      return await this.retry(jobId);
    }
    throw new Error(`Unknown DLQ subcommand: ${subcmd}`);
  }

  close(): void {
    this.storage.close?.();
  }
}
export default DLQManager;
export { DLQManager };