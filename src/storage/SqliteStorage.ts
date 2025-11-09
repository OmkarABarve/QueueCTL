import Database from 'better-sqlite3';
import type { IStorage } from './IStorage';
import type { JobJSON, JobState } from '../types';
import { Job } from '../core/Job';

type JobsRow = {
  id: string;
  command: string;
  state: JobState;
  attempts: number;
  max_retries: number;
  created_at: string;
  updated_at: string;
  run_at: string | null;
  next_attempt_at: string | null;
  backoff_base: number | null;
  last_error: string | null;
};

type DlqRow = { payload: string };

export class SqliteStorage implements IStorage {
    private db: Database.Database;
  
    constructor(private filePath: string) {
      this.db = new Database(this.filePath);
    }

  init(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        command TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending','processing','completed','failed','dead')),
        attempts INTEGER NOT NULL,
        max_retries INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        run_at TEXT,
        next_attempt_at TEXT,
        backoff_base INTEGER,
        last_error TEXT
      );

      CREATE TABLE IF NOT EXISTS dlq (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL, -- stores JobJSON string
        dead_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(state);
      CREATE INDEX IF NOT EXISTS idx_jobs_next_attempt ON jobs(next_attempt_at);
      CREATE INDEX IF NOT EXISTS idx_jobs_run_at ON jobs(run_at);
    `);
  }

  enqueue(job: Job): void {
    const j = job.toJSON();
    this.db.prepare(`
      INSERT INTO jobs (
        id, command, state, attempts, max_retries, created_at, updated_at,
        run_at, next_attempt_at, backoff_base, last_error
      ) VALUES (@id, @command, @state, @attempts, @max_retries, @created_at, @updated_at,
        @run_at, @next_attempt_at, @backoff_base, @last_error)
    `).run(j);
  }

  update(job: Job): void {
    const j = job.toJSON();
    this.db.prepare(`
      UPDATE jobs SET
        command=@command, state=@state, attempts=@attempts, max_retries=@max_retries,
        created_at=@created_at, updated_at=@updated_at, run_at=@run_at,
        next_attempt_at=@next_attempt_at, backoff_base=@backoff_base, last_error=@last_error
      WHERE id=@id
    `).run(j);
  }

  getById(id: string): Job | null {
    const row = this.db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as JobsRow | undefined;
    return row ? Job.fromJSON(this.rowToJSON(row)) : null;
  }

  // Atomically lease the next due job; prevents duplicate processing across workers
  leaseNext(at: Date = new Date()): Job | null {
    const selectStmt = this.db.prepare(`
      SELECT id
      FROM jobs
      WHERE
        (state='pending' AND (run_at IS NULL OR run_at <= ?))
        OR
        (state='failed' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
      ORDER BY COALESCE(next_attempt_at, run_at, created_at) ASC, created_at ASC
      LIMIT 1
    `);

    const updateStmt = this.db.prepare(`
      UPDATE jobs
      SET state='processing', updated_at=@now
      WHERE id=@id
        AND (
          (state='pending' AND (run_at IS NULL OR run_at <= @now))
          OR
          (state='failed' AND (next_attempt_at IS NULL OR next_attempt_at <= @now))
        )
    `);

    const getStmt = this.db.prepare(`SELECT * FROM jobs WHERE id=?`);

    const tx = this.db.transaction((nowISO: string) => {
      for (let i = 0; i < 5; i++) {
        const sel = selectStmt.get(nowISO, nowISO) as { id: string } | undefined;
        if (!sel) return null;
        const res = updateStmt.run({ now: nowISO, id: sel.id });
        if (res.changes === 1) {
          return getStmt.get(sel.id) as JobsRow;
        }
        // lost the race; try again
      }
      return null;
    });

    const row = tx(at.toISOString());
    return row ? Job.fromJSON(this.rowToJSON(row as JobsRow)) : null;
  }

  list(state?: JobState): Job[] {
    const rows: JobsRow[] = state
      ? (this.db.prepare(`SELECT * FROM jobs WHERE state = ?`).all(state) as JobsRow[])
      : (this.db.prepare(`SELECT * FROM jobs`).all() as JobsRow[]);
    return rows.map((r: JobsRow) => Job.fromJSON(this.rowToJSON(r)));
  }

  moveToDLQ(job: Job): void {
    const j = job.toJSON();
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM jobs WHERE id=?`).run(j.id);
      this.db.prepare(`
        INSERT INTO dlq (id, payload, dead_at) VALUES (?, ?, ?)
      `).run(j.id, JSON.stringify(j), new Date().toISOString());
    });
    tx();
  }

  listDLQ(): Job[] {
    const rows = this.db.prepare(`SELECT payload FROM dlq ORDER BY dead_at ASC`).all() as DlqRow[];
    const out: Job[] = [];
    for (const { payload } of rows) {
      try {
        const obj = JSON.parse(payload) as JobJSON;
        out.push(Job.fromJSON(obj));
      } catch {
        // skip corrupt payloads
        continue;
      }
    }
    return out;
  }

  retryFromDLQ(id: string): Job | null {
    const tx = this.db.transaction(() => {
      const row = this.db.prepare(`SELECT payload FROM dlq WHERE id=?`).get(id) as DlqRow | undefined;
      if (!row) return null;
      this.db.prepare(`DELETE FROM dlq WHERE id=?`).run(id);

      let parsed: JobJSON | null = null;
      try {
        parsed = JSON.parse(row.payload) as JobJSON;
      } catch {
        parsed = null;
      }
      if (!parsed) return null;

      const j = Job.fromJSON(parsed);
      j.resetForRetry({ keepAttempts: false });
      this.enqueue(j);
      return j;
    });
    return tx();
  }

  close(): void {
    this.db.close();
  }

  private rowToJSON(row: JobsRow): JobJSON {
    return {
      id: row.id,
      command: row.command,
      state: row.state,
      attempts: row.attempts,
      max_retries: row.max_retries,
      created_at: row.created_at,
      updated_at: row.updated_at,
      run_at: row.run_at ?? undefined,
      next_attempt_at: row.next_attempt_at ?? undefined,
      backoff_base: row.backoff_base ?? undefined,
      last_error: row.last_error ?? undefined,
    };
  }
}