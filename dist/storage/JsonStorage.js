"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.JsonStorage = void 0;
// src/storage/JsonStorage.ts
const fs_1 = require("fs");
const fscb = __importStar(require("fs"));
const path = __importStar(require("path"));
const Job_1 = require("../core/Job");
class JsonStorage {
    constructor(options) {
        const dir = path.resolve(options.dir);
        this.paths = {
            dir,
            jobs: path.join(dir, 'jobs.json'),
            dlq: path.join(dir, 'dlq.json'),
            lock: path.join(dir, 'queue.lock'),
        };
        this.lockTimeoutMs = options.lockTimeoutMs ?? 5000;
        this.retryDelayMs = options.retryDelayMs ?? 25;
    }
    async init() {
        await fs_1.promises.mkdir(this.paths.dir, { recursive: true });
        await this.ensureFile(this.paths.jobs, '[]\n');
        await this.ensureFile(this.paths.dlq, '[]\n');
    }
    // ---------- write paths ----------
    async enqueue(job) {
        await this.withLock(async () => {
            const jobs = await this.readJobs();
            if (jobs.some(j => j.id === job.id)) {
                throw new Error(`Job already exists: ${job.id}`);
            }
            jobs.push(job.toJSON());
            await this.writeJobs(jobs);
        });
    }
    async update(job) {
        await this.withLock(async () => {
            const jobs = await this.readJobs();
            const idx = jobs.findIndex(j => j.id === job.id);
            if (idx === -1) {
                throw new Error(`Job not found: ${job.id}`);
            }
            jobs[idx] = job.toJSON();
            await this.writeJobs(jobs);
        });
    }
    async moveToDLQ(job) {
        await this.withLock(async () => {
            const [jobs, dlq] = await Promise.all([this.readJobs(), this.readDLQ()]);
            const idx = jobs.findIndex(j => j.id === job.id);
            if (idx !== -1) {
                jobs.splice(idx, 1);
            }
            dlq.push(job.toJSON());
            await Promise.all([this.writeJobs(jobs), this.writeDLQ(dlq)]);
        });
    }
    // ---------- read/lease ----------
    async getById(id) {
        const jobs = await this.readJobs();
        const found = jobs.find(j => j.id === id);
        return found ? Job_1.Job.fromJSON(found) : null;
    }
    // Atomically lease the next due job; marks it 'processing' to avoid duplicates
    async leaseNext(at = new Date()) {
        return await this.withLock(async () => {
            const jobs = await this.readJobs();
            // Find due jobs (pending due or failed retryable due)
            const candidates = [];
            for (const j of jobs) {
                const job = Job_1.Job.fromJSON(j);
                if (job.isDue(at)) {
                    candidates.push(j);
                }
            }
            if (candidates.length === 0)
                return null;
            // Sort by effective due time then created_at (FIFO)
            candidates.sort((a, b) => {
                const ad = effectiveDueAt(a);
                const bd = effectiveDueAt(b);
                if (ad !== bd)
                    return ad - bd;
                return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
            });
            // Take the first candidate and mark processing
            const selected = candidates[0];
            const idx = jobs.findIndex(j => j.id === selected.id);
            if (idx === -1)
                return null;
            const leased = { ...jobs[idx] };
            const now = new Date().toISOString();
            leased.state = 'processing';
            leased.updated_at = now;
            jobs[idx] = leased;
            await this.writeJobs(jobs);
            return Job_1.Job.fromJSON(leased);
        });
    }
    // ---------- queries ----------
    async list(state) {
        const jobs = await this.readJobs();
        const filtered = state ? jobs.filter(j => j.state === state) : jobs;
        return filtered.map(j => Job_1.Job.fromJSON(j));
    }
    async listDLQ() {
        const dlq = await this.readDLQ();
        return dlq.map(j => Job_1.Job.fromJSON(j));
    }
    async retryFromDLQ(id) {
        return await this.withLock(async () => {
            const [jobs, dlq] = await Promise.all([this.readJobs(), this.readDLQ()]);
            const idx = dlq.findIndex(j => j.id === id);
            if (idx === -1)
                return null;
            const payload = dlq[idx];
            dlq.splice(idx, 1);
            const job = Job_1.Job.fromJSON(payload);
            job.resetForRetry({ keepAttempts: false });
            if (jobs.some(j => j.id === job.id)) {
                // replace existing if same id present
                const jdx = jobs.findIndex(j => j.id === job.id);
                jobs[jdx] = job.toJSON();
            }
            else {
                jobs.push(job.toJSON());
            }
            await Promise.all([this.writeJobs(jobs), this.writeDLQ(dlq)]);
            return job;
        });
    }
    close() {
        // no-op for file-based storage
    }
    // ---------- internals ----------
    async ensureFile(filePath, initial) {
        try {
            await fs_1.promises.access(filePath);
        }
        catch {
            await fs_1.promises.writeFile(filePath, initial, 'utf8');
        }
    }
    async readJobs() {
        try {
            const raw = await fs_1.promises.readFile(this.paths.jobs, 'utf8');
            const data = JSON.parse(raw);
            return Array.isArray(data) ? data : [];
        }
        catch {
            return [];
        }
    }
    async writeJobs(jobs) {
        await fs_1.promises.writeFile(this.paths.jobs, JSON.stringify(jobs, null, 2) + '\n', 'utf8');
    }
    async readDLQ() {
        try {
            const raw = await fs_1.promises.readFile(this.paths.dlq, 'utf8');
            const data = JSON.parse(raw);
            return Array.isArray(data) ? data : [];
        }
        catch {
            return [];
        }
    }
    async writeDLQ(dlq) {
        await fs_1.promises.writeFile(this.paths.dlq, JSON.stringify(dlq, null, 2) + '\n', 'utf8');
    }
    // Basic lock using an exclusive lock file. Retries until acquired or timeout.
    async withLock(fn) {
        const start = Date.now();
        while (true) {
            try {
                const fd = fscb.openSync(this.paths.lock, fscb.constants.O_CREAT | fscb.constants.O_EXCL | fscb.constants.O_WRONLY, 0o644);
                try {
                    fscb.writeFileSync(fd, `${process.pid} ${new Date().toISOString()}`);
                }
                finally {
                    fscb.closeSync(fd);
                }
                break; // acquired
            }
            catch (err) {
                if (err && err.code === 'EEXIST') {
                    if (Date.now() - start > this.lockTimeoutMs) {
                        throw new Error(`JsonStorage: failed to acquire lock within ${this.lockTimeoutMs}ms`);
                    }
                    await sleep(this.retryDelayMs);
                    continue;
                }
                throw err;
            }
        }
        try {
            return await fn();
        }
        finally {
            try {
                await fs_1.promises.unlink(this.paths.lock);
            }
            catch {
                // ignore
            }
        }
    }
}
exports.JsonStorage = JsonStorage;
function effectiveDueAt(j) {
    const ts = j.next_attempt_at ?? j.run_at ?? j.created_at;
    return new Date(ts).getTime();
}
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
//# sourceMappingURL=JsonStorage.js.map