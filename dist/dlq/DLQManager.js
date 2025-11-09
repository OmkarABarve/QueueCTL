"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DLQManager = void 0;
const Config_1 = require("../config/Config");
class DLQManager {
    constructor(storage) {
        this.storage = storage;
    }
    static async fromConfig() {
        const cfg = (0, Config_1.loadConfig)();
        const storage = (0, Config_1.createStorage)(cfg);
        await storage.init?.();
        return new DLQManager(storage);
    }
    // Move a job to DLQ immediately (use this when you detect a job has gone 'dead')
    async add(job) {
        await this.storage.moveToDLQ(job);
    }
    // Sweep any persisted 'dead' jobs into the DLQ (useful if state was updated but not moved yet)
    async sweepDeadToDLQ() {
        const dead = await this.storage.list('dead');
        let moved = 0;
        for (const j of dead) {
            await this.storage.moveToDLQ(j);
            moved++;
        }
        return moved;
    }
    // List jobs currently in DLQ
    async list() {
        return await this.storage.listDLQ();
    }
    // Retry a job from DLQ: removes it from DLQ, resets state to 'pending', enqueues it back
    async retry(jobId) {
        return await this.storage.retryFromDLQ(jobId);
    }
    // Small helper to wire into a CLI command layer
    async runCommand(subcmd, jobId) {
        if (subcmd === 'list') {
            return await this.list();
        }
        if (subcmd === 'retry') {
            if (!jobId)
                throw new Error('dlq retry requires <jobId>');
            return await this.retry(jobId);
        }
        throw new Error(`Unknown DLQ subcommand: ${subcmd}`);
    }
    close() {
        this.storage.close?.();
    }
}
exports.DLQManager = DLQManager;
exports.default = DLQManager;
//# sourceMappingURL=DLQManager.js.map