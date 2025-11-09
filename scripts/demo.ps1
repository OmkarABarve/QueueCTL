#!/usr/bin/env pwsh
$ErrorActionPreference = "Stop"

# Build
npm run build

# JSON storage for a clean demo
$env:QUEUECTL_STORAGE = "json"
$env:QUEUECTL_JSON_DIR = (Join-Path (Get-Location) ".demo-data")
if (Test-Path $env:QUEUECTL_JSON_DIR) { Remove-Item -Recurse -Force $env:QUEUECTL_JSON_DIR }
New-Item -ItemType Directory -Force -Path $env:QUEUECTL_JSON_DIR | Out-Null

Write-Host "Enqueue two jobs..."
node dist/index.js enqueue "echo Hello_1"
node dist/index.js enqueue "echo Hello_2"

Write-Host "Start a worker ..."
# Start in the foreground for Windows; alternatively use Start-Process for background
Start-Process -FilePath "node" -ArgumentList "dist/index.js","worker","start","--count","1","--poll","250","--timeout","10000" -PassThru | Tee-Object -Variable workerProc | Out-Null

Start-Sleep -Seconds 2

Write-Host "Status after processing:"
node dist/index.js status

Write-Host "Stop worker..."
# Use worker stop via PID file if available, else stop the process we started
node dist/index.js worker stop
if ($LASTEXITCODE -ne 0 -and $workerProc) {
  Stop-Process -Id $workerProc.Id -Force -ErrorAction SilentlyContinue
}

Write-Host "Final status:"
node dist/index.js status

Write-Host "Demo complete."