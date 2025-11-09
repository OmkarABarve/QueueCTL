import type { IStorage } from '../storage/IStorage';
export type StorageDriver = 'sqlite' | 'json';
export interface Config {
    storage: {
        driver: StorageDriver;
        sqlitePath: string;
        jsonDir: string;
    };
    worker: {
        pollIntervalMs: number;
        concurrency: number;
    };
}
export declare function loadConfig(): Config;
export declare function createStorage(cfg: Config): IStorage;
