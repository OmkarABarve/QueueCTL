## QueueCTL

A lightweight local job queue CLI with worker execution, exponential backoff retries, and a Dead Letter Queue (DLQ), built in TypeScript.

### Project Overview

QueueCTL lets you enqueue shell commands as jobs, process them with one or more worker loops, handle failures with exponential backoff retries, and move exhausted jobs into a Dead Letter Queue for later inspection and retry.

---

## Setup Instructions

### Prerequisites
- Node.js 18+ and npm

### Install dependencies and build

```bash
npm install
npm run build
```

Run the CLI help:

```bash
node dist/index.js --help
# or if installed globally:
# npm i -g .
# queuectl --help
```

### Storage backends

QueueCTL supports two local persistence options:
- SQLite (default): stores jobs in a single `.db` file
- JSON: stores jobs and DLQ in JSON files in a directory

You can configure storage via environment variables or the `config` command.

- Use SQLite (default):
  - `QUEUECTL_STORAGE=sqlite` (default if unset)
  - `QUEUECTL_SQLITE_PATH=./queue.db` (default is `queue.db` in cwd)

- Use JSON:
  - `QUEUECTL_STORAGE=json`
  - `QUEUECTL_JSON_DIR=./.queue-data` (default is `.queue-data` in cwd)

Examples:

```bash
# SQLite (default):
npm run build
node dist/index.js status

# JSON:
export QUEUECTL_STORAGE=json
export QUEUECTL_JSON_DIR=$(pwd)/.queue-data
node dist/index.js status
```

On Windows PowerShell:

```powershell
$env:QUEUECTL_STORAGE = "json"
$env:QUEUECTL_JSON_DIR = (Join-Path (Get-Location) ".queue-data")
node dist/index.js status
```

---

## Usage Examples

Below are common commands. You can always run `--help` on any command or subcommand.

### Enqueue

Create a job from a shell command. You can optionally defer execution (`--run-at`), set retries (`--max-retries`), or change backoff base (`--backoff-base`).

```bash
node dist/index.js enqueue "echo Hello_Queue"
# with options:
node dist/index.js enqueue "echo Later" --run-at "2030-01-01T00:00:00Z" --max-retries 5 --backoff-base 2
```

Sample output:

```json
{
  "id": "f5d9c8a8-3b3e-4b45-9f7f-cb0a0c9f2a3a",
  "command": "echo Hello_Queue",
  "state": "pending",
  "attempts": 0,
  "max_retries": 3,
  "created_at": "2025-01-01T12:00:00.000Z",
  "updated_at": "2025-01-01T12:00:00.000Z",
  "backoff_base": 2
}
```

### Worker start/stop

Start a worker. Options:
- `--concurrency <n>`: number of parallel execution loops (default from config)
- `--poll <ms>`: idle polling interval (default from config)
- `--timeout <ms>`: per-job execution timeout

```bash
node dist/index.js worker start --concurrency 2 --poll 250 --timeout 10000
# stop the worker running in this directory (uses PID file queuectl.worker.pid)
node dist/index.js worker stop
```

While running, worker logs stream job output:

```
[<job-id>] stdout: Hello_Queue
```

### Status

Get counts per lifecycle state plus DLQ size:

```bash
node dist/index.js status
```

Sample output:

```json
{
  "pending": 0,
  "processing": 0,
  "completed": 2,
  "failed": 0,
  "dead": 0,
  "dlq": 0
}
```

### List jobs

List all jobs or filter by a specific state:

```bash
node dist/index.js list
node dist/index.js list --state failed
```

### DLQ operations

List jobs currently in the DLQ:

```bash
node dist/index.js dlq list
```

Retry (revive) a DLQ job back into the queue:

```bash
node dist/index.js dlq retry <jobId>
# prints: Requeued job <jobId>
```

Note: “revive” is implemented as `dlq retry`.

### Config

Get or set configuration. Values are persisted in `queuectl.config.json` in your current directory and overlaid on environment defaults.

```bash
node dist/index.js config get
node dist/index.js config set storage.driver json
node dist/index.js config set storage.sqlitePath ./queue.db
node dist/index.js config set worker.concurrency 2
node dist/index.js config set worker.pollIntervalMs 250
```

### Demo script

A ready-to-run demo is included:

- macOS/Linux:

```bash
bash scripts/demo.sh
```

- Windows PowerShell:

```powershell
pwsh scripts/demo.ps1
```

Sample demo output (truncated):

```
Enqueue two jobs...
{ ...job JSON... }
{ ...job JSON... }
Start a worker (background) ...
[8a2c...] stdout: Hello_1
[1c5b...] stdout: Hello_2
Status after processing:
{
  "pending": 0,
  "processing": 0,
  "completed": 2,
  "failed": 0,
  "dead": 0,
  "dlq": 0
}
Stop worker...
Final status:
{
  "pending": 0,
  "processing": 0,
  "completed": 2,
  "failed": 0,
  "dead": 0,
  "dlq": 0
}
Demo complete.
```

Run the help at any time:

```bash
npm run build && node dist/index.js --help
```

---

## Architecture Overview

- `Job`: Immutable data model + state transitions for `pending`, `processing`, `completed`, `failed`, `dead`. Implements exponential backoff where delay = backoff_base^attempts (default base 2).
- `Queue`: In-memory scheduling logic used by the `Worker` (unit-tested) to select the next due job and ensure safe transitions.
- `Worker`: Multi-loop worker that leases jobs from storage (via storage adapters), executes with an `Executor`, applies retry/DLQ transitions, and supports graceful shutdown. Concurrency is achieved via multiple async loops in a single process.
- `Executor`: Spawns shell commands, streams output, enforces optional per-job timeouts, and surfaces failures.
- `DLQManager`: Lists and retries jobs stored in the DLQ.
- `Storage adapters`:
  - `SqliteStorage`: Durable SQLite-backed store with atomic leasing (`leaseNext`) to prevent duplicate processing across workers.
  - `JsonStorage`: File-based store with a simple lock file for safe concurrent access; useful for local demos/tests.

Flow of a job:
1. Enqueue → state `pending` (optional `run_at`).
2. Worker leases due job → state `processing`.
3. On success → `completed`.
4. On failure → `failed`, `attempts += 1`, schedule `next_attempt_at = now + base^attempts` seconds.
5. If `attempts > max_retries` → `dead` and moved to DLQ.
6. DLQ jobs can be retried (revived) back to `pending`.

CLI implementation:
- Built with Commander; top-level and subcommands call into storage adapters created via `Config`.
- Configuration merges environment variables with `queuectl.config.json` in the current directory.

---

## Assumptions & Trade-offs

- Local persistence (SQLite/JSON) for simplicity; no external message broker.
- Single-process worker with configurable concurrency (multiple async loops).
- Simplified retry/backoff and timeouts suitable for local/edge use; not a distributed scheduler.

---

## Testing Instructions

Run the test suite:

```bash
npm test
```

What’s covered:
- `tests/job.test.ts`: Job lifecycle, validation, exponential backoff, serialization round-trip.
- `tests/queue.test.ts`: Scheduling order (due time + FIFO), safe transitions, requeue operations, index maintenance.
- `tests/integration.test.ts`: End-to-end flow using `JsonStorage` + `DLQManager`:
  - enqueue → fail (retryable) → fail to dead → move to DLQ → retry from DLQ → complete.

Verify end-to-end behavior:
1. Run the demo script (see above).
2. Observe worker logs for job output.
3. Check `status` shows completed count and empty DLQ at the end.

---

## License and Credits

- License: MIT (feel free to adapt and extend).
- Built with TypeScript, Commander, and SQLite.
