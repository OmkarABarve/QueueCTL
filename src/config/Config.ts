// src/config/Config.ts
import * as path from 'path';
import type { IStorage } from '../storage/IStorage';
import { SqliteStorage } from '../storage/SqliteStorage';
import { JsonStorage } from '../storage/JsonStorage';

export type StorageDriver = 'sqlite' | 'json';

export interface Config {
  storage: {
    driver: StorageDriver;
    sqlitePath: string; // used if driver = sqlite
    jsonDir: string;    // used if driver = json
  };
  worker: {
    pollIntervalMs: number;
    concurrency: number;
  };
}

export function loadConfig(): Config {
  const root = process.cwd();
  const driver = (process.env.QUEUECTL_STORAGE as StorageDriver) ?? 'sqlite';

  return {
    storage: {
      driver,
      sqlitePath: process.env.QUEUECTL_SQLITE_PATH ?? path.join(root, 'queue.db'),
      jsonDir: process.env.QUEUECTL_JSON_DIR ?? path.join(root, '.queue-data'),
    },
    worker: {
      pollIntervalMs: Number(process.env.QUEUECTL_POLL_MS ?? '500'),
      concurrency: Math.max(1, Number(process.env.QUEUECTL_CONCURRENCY ?? '1')),
    },
  };
}

export function createStorage(cfg: Config): IStorage {
  if (cfg.storage.driver === 'json') {
    return new JsonStorage({ dir: cfg.storage.jsonDir });
  }
  return new SqliteStorage(cfg.storage.sqlitePath);
}