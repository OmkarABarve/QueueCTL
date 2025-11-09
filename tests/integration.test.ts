// tests/integration.test.ts
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { JsonStorage } from '../src/storage/JsonStorage';
import { Job } from '../src/core/Job';
import { DLQManager } from '../src/dlq/DLQManager';

function tmpDir(prefix = 'queuectl-'): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('Integration: enqueue → process → fail → retry → DLQ → revive', () => {
  test('full flow using JsonStorage + DLQManager', async () => {
    const dir = await tmpDir();
    const storage = new JsonStorage({ dir });
    await storage.init();

    // enqueue
    const job = Job.create({ command: 'failing-task', max_retries: 1, backoff_base: 2 });
    await storage.enqueue(job);

    // lease and simulate failure (attempt 1 => failed with backoff)
    let leased = await storage.leaseNext(new Date());
    expect(leased).toBeTruthy();
    leased!.markFailed(new Error('first fail'));
    await storage.update(leased!);

    // advance time enough to retry; lease again and fail to dead
    leased = await storage.leaseNext(new Date(Date.now() + 10_000));
    expect(leased).toBeTruthy();
    leased!.markFailed('second fail'); // attempts > max => dead
    expect(leased!.state).toBe('dead');

    // move to DLQ
    await storage.moveToDLQ(leased!);

    // verify DLQ list
    const dlqMgr = new DLQManager(storage);
    const dlqItems = await dlqMgr.list();
    expect(dlqItems.length).toBe(1);
    expect(dlqItems[0]!.id).toBe(job.id);

    // revive via retryFromDLQ
    const revived = await dlqMgr.retry(job.id);
    expect(revived).toBeTruthy();
    expect(revived!.state).toBe('pending');
    expect(revived!.attempts).toBe(0);

    // lease and "succeed"
    const finalLease = await storage.leaseNext(new Date());
    expect(finalLease?.id).toBe(job.id);
    finalLease!.markCompleted();
    await storage.update(finalLease!);

    // verify no items in DLQ now, and completed not in main queue list('completed') via storage
    const dlqEmpty = await dlqMgr.list();
    expect(dlqEmpty.length).toBe(0);

    const completed = await storage.list('completed');
    expect(completed.find((j) => j.id === job.id)).toBeTruthy();
  });
});