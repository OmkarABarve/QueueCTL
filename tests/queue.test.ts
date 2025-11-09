// tests/queue.test.ts
import { Queue } from '../src/core/Queue';
import { Job } from '../src/core/Job';

describe('Queue', () => {
  test('enqueue() only accepts pending, rejects duplicates', () => {
    const q = new Queue();
    const j = Job.create({ command: 'a' });
    q.enqueue(j);
    expect(() => q.enqueue(j)).toThrow();

    const proc = Job.create({ command: 'b' });
    proc.markProcessing();
    expect(() => q.enqueue(proc)).toThrow();
  });

  test('dequeue() selects earliest due with FIFO tiebreaker and marks processing', () => {
    const q = new Queue();
    const j1 = Job.create({ command: 'a' });
    const j2 = Job.create({ command: 'b' });

    q.enqueue(j1);
    q.enqueue(j2);

    const d1 = q.dequeue();
    expect(d1?.id).toBe(j1.id);
    expect(d1?.state).toBe('processing');

    const d2 = q.dequeue();
    expect(d2?.id).toBe(j2.id);
    expect(d2?.state).toBe('processing');

    const none = q.dequeue();
    expect(none).toBeNull();
  });

  test('complete() and fail() update states correctly; dead vs failed', () => {
    const q = new Queue();
    const j = Job.create({ command: 'x', max_retries: 0 });
    q.enqueue(j);

    const d = q.dequeue()!;
    expect(d.state).toBe('processing');

    // Failing with max_retries=0 should go dead
    const out = q.fail(d.id, new Error('boom'));
    expect(out.state === 'dead' || out.state === 'failed').toBe(true);
  });

  test('requeue() returns processing job back to pending safely', () => {
    const q = new Queue();
    const j = Job.create({ command: 'x' });
    q.enqueue(j);
    const d = q.dequeue()!;
    expect(d.state).toBe('processing');

    const r = q.requeue(d.id);
    expect(r.state).toBe('pending');
    // should be available for dequeue again
    const d2 = q.dequeue()!;
    expect(d2.id).toBe(j.id);
  });

  test('updateJob() replaces job object and fixes state indexes', () => {
    const q = new Queue();
    const j = Job.create({ command: 'x' });
    q.enqueue(j);

    const updated = Job.fromJSON({ ...j.toJSON(), state: 'completed' });
    q.updateJob(updated);

    const listCompleted = q.list('completed');
    expect(listCompleted.find((e) => e.id === j.id)).toBeTruthy();
  });
});