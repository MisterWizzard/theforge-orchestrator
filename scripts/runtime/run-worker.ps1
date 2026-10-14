#requires -Version 7
<#
.SYNOPSIS
  Run the worker from the repository root, logging to <LogDir>\worker-<yyyyMMdd>.log.

.DESCRIPTION
  The action behind the "TheForge Worker" scheduled task (register-runtime.ps1),
  and equally runnable by hand. Same contract as run-coordinator.ps1 - no build,
  exit 3 without .env or apps/worker/dist/index.js, both streams appended to the
  day's log, 14 daily files kept, node's exit code passed through - plus one
  wait: the worker needs Docker Desktop's engine for the sandbox, and at logon
  the engine comes up some time after the task fires, so this script polls
  `docker info` for up to five minutes before starting node and exits 4 if the
  engine never answers (Task Scheduler then retries a minute later).

  The worker retries its registration with the coordinator eight times with
  backoff (apps/worker/src/index.ts), which covers the coordinator task starting
  a little later than this one.

.PARAMETER LogDir
  Where the daily log files go. Default C:\forge\logs; keep it in step with
  FORGE_LOG_DIR in .env, which is what `pnpm forge runtime status` reads.

.PARAMETER DockerWaitSeconds
  How long to wait for `docker info` to succeed before giving up with exit 4.
#>
[CmdletBinding()]
param(
  [string] $LogDir = 'C:\forge\logs',
  [int] $DockerWaitSeconds = 300
)
. (Join-Path $PSScriptRoot 'runtime-common.ps1')

$waitForDocker = {
  param($log)
  Wait-ForgeDocker -TimeoutSeconds $DockerWaitSeconds -Log $log
}

Invoke-ForgeApp -App 'worker' -Entry 'apps/worker/dist/index.js' -LogDir $LogDir -Runner 'run-worker.ps1' -BeforeStart $waitForDocker
