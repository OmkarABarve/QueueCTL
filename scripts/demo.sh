#!/usr/bin/env bash
set -euo pipefail

# Build the CLI
npm run build

# Use JSON storage for a clean demo run
export QUEUECTL_STORAGE=json
export QUEUECTL_JSON_DIR="$(pwd)/.demo-data"
rm -rf "$QUEUECTL_JSON_DIR"
mkdir -p "$QUEUECTL_JSON_DIR"

echo "Enqueue two jobs..."
node dist/index.js enqueue "echo Hello_1"
node dist/index.js enqueue "echo Hello_2"

echo "Start a worker (background) ..."
node dist/index.js worker start --count 1 --poll 250 --timeout 10000 &
WORKER_PID=$!

# Give the worker a moment to process
sleep 2

echo "Status after processing:"
node dist/index.js status

echo "Stop worker..."
kill "$WORKER_PID" 2>/dev/null || true
wait "$WORKER_PID" 2>/dev/null || true

echo "Final status:"
node dist/index.js status

echo "Demo complete."

