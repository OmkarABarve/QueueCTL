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
exports.loadConfig = loadConfig;
exports.createStorage = createStorage;
// src/config/Config.ts
const path = __importStar(require("path"));
const SqliteStorage_1 = require("../storage/SqliteStorage");
const JsonStorage_1 = require("../storage/JsonStorage");
function loadConfig() {
    const root = process.cwd();
    const driver = process.env.QUEUECTL_STORAGE ?? 'sqlite';
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
function createStorage(cfg) {
    if (cfg.storage.driver === 'json') {
        return new JsonStorage_1.JsonStorage({ dir: cfg.storage.jsonDir });
    }
    return new SqliteStorage_1.SqliteStorage(cfg.storage.sqlitePath);
}
//# sourceMappingURL=Config.js.map