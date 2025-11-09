// tests/job.test.ts
import { Job, DEFAULT_MAX_RETRIES, DEFAULT_BACKOFF_BASE } from '../src/core/Job';

describe('Job', () => {
  test('create(): sets defaults and validates', () => {
    const j = Job.create({ command: 'echo 1' });
    expect(j.command).toBe('echo 1');
    expect(j.state).toBe('pending');
    expect(j.attempts).toBe(0);
    expect(j.max_retries).toBe(DEFAULT_MAX_RETRIES);
    expect(j.backoff_base).toBe(DEFAULT_BACKOFF_BASE);
    expect(typeof j.created_at).toBe('string');
    expect(typeof j.updated_at).toBe('string');
  });

  test('markProcessing(): allowed from pending, not from completed', () => {
    const j = Job.create({ command: 'x' });
    j.markProcessing();
    expect(j.state).toBe('processing');
    expect(() => j.markProcessing()).toThrow(); // already processing
  });

  test('markCompleted(): only from processing', () => {
    const j = Job.create({ command: 'x' });
    expect(() => j.markCompleted()).toThrow();
    j.markProcessing();
    j.markCompleted();
    expect(j.state).toBe('completed');
    expect(j.last_error).toBeUndefined();
    expect(j.next_attempt_at).toBeUndefined();
  });

  test('markFailed(): increments attempts, sets backoff and failed, then dead after exceeding max', () => {
    const j = Job.create({ command: 'x', max_retries: 1, backoff_base: 2 });
    j.markProcessing();

    j.markFailed(new Error('boom'));
    expect(j.state).toBe('failed');
    expect(j.attempts).toBe(1);
    expect(j.last_error).toBe('boom');
    expect(j.next_attempt_at).toBeTruthy();

    // Next failure should push to dead (attempts becomes 2 > max_retries 1)
    j.markProcessing(); // simulate retry lease
    j.markFailed('again');
    expect(j.state).toBe('dead');
    expect(j.next_attempt_at).toBeUndefined();
  });

  test('isRetryable(): true while attempts < max and not completed/dead', () => {
    const j = Job.create({ command: 'x', max_retries: 2 });
    expect(j.isRetryable()).toBe(true);
    j.markProcessing();
    j.markFailed('e1'); // attempts=1
    expect(j.isRetryable()).toBe(true);
    j.markProcessing();
    j.markFailed('e2'); // attempts=2 -> failed but attempts == max, still retryable for another mark? No (only < max)
    expect(j.isRetryable()).toBe(false);
  });

  test('isDue(): honors run_at for pending and next_attempt_at for failed', () => {
    const now = new Date();
    const future = new Date(now.getTime() + 60_000);

    const p = Job.create({ command: 'x', run_at: future });
    expect(p.isDue(now)).toBe(false);
    expect(p.isDue(new Date(future.getTime() + 1))).toBe(true);

    const f = Job.create({ command: 'x' });
    f.markProcessing();
    f.markFailed('e');
    const due = f.next_attempt_at!;
    expect(f.isDue(new Date(new Date(due).getTime() - 1))).toBe(false);
    expect(f.isDue(new Date(new Date(due).getTime() + 1))).toBe(true);
  });

  test('toJSON()/fromJSON() round-trip', () => {
    const a = Job.create({ command: 'echo hi', max_retries: 5, backoff_base: 3 });
    const b = Job.fromJSON(a.toJSON());
    expect(b.command).toBe(a.command);
    expect(b.max_retries).toBe(5);
    expect(b.backoff_base).toBe(3);
    expect(b.state).toBe('pending');
  });
});