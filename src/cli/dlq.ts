// src/cli/dlq.ts- CLI Wiring for DLQManager
import { DLQManager } from '../dlq/DLQManager';

async function main() {
  const [, , subcmd, jobId] = process.argv; // e.g. node dist/cli/dlq.js list | retry <id>
  const mgr = await DLQManager.fromConfig();
  try {
    if (!subcmd || (subcmd !== 'list' && subcmd !== 'retry')) {
      console.error('Usage: dlq <list|retry> [jobId]');
      process.exit(1);
    }

    if (subcmd === 'list') {
      const items = await mgr.list();
      console.log(JSON.stringify(items.map(j => j.toJSON()), null, 2));
      return;
    }

    if (!jobId) {
      console.error('Usage: dlq retry <jobId>');
      process.exit(1);
    }
    const res = await mgr.retry(jobId);
    if (!res) {
      console.error(`Job ${jobId} not found in DLQ`);
      process.exit(2);
    }
    console.log(`Requeued job ${jobId}`);
  } finally {
    mgr.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});