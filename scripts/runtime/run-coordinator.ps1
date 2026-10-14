#requires -Version 7
<#
.SYNOPSIS
  Run the coordinator from the repository root, logging to <LogDir>\coordinator-<yyyyMMdd>.log.

.DESCRIPTION
  The action behind the "TheForge Coordinator" scheduled task (register-runtime.ps1),
  and equally runnable by hand. It builds nothing: it expects `corepack pnpm build`
  to have produced apps/coordinator/dist/server.js and refuses (exit 3) otherwise,
  as it does without a .env. Both output streams are appended to the day's log
  file, the newest 14 daily files are kept, and the script exits with node's own
  exit code so Task Scheduler restarts a crash and leaves a clean exit alone.

  Like the worker runner, it first waits for Docker Desktop's engine. The
  coordinator's PostgreSQL and Redis run as containers, so without the engine
  it cannot connect and node exits 1 at once. Measured on the reboot of
  27/09/2026 (BLK-019): the engine was still not up ten minutes in, and because
  the watchdog trigger re-fires every minute this crash-looped about sixty times
  an hour, filling the day's log, while the worker sat politely retrying the very
  same engine. Waiting costs nothing and says what it is waiting for; exit 4
  after the timeout lets the watchdog try again later.

  Stopping: `pnpm forge halt` writes the halt file, which both runners honour.
  `pnpm forge runtime stop` also stops the tasks, but the watchdog restarts them
  within a minute, so the halt file is the durable stop. See docs/OPERATIONS.md
  "Running TheForge as a service on Windows".

.PARAMETER LogDir
  Where the daily log files go. Default C:\forge\logs; keep it in step with
  FORGE_LOG_DIR in .env, which is what `pnpm forge runtime status` reads.

.PARAMETER DockerWaitSeconds
  How long to wait for `docker info` to succeed before giving up with exit 4.
  Same default as the worker runner.
#>
[CmdletBinding()]
param(
  [string] $LogDir = 'C:\forge\logs',
  [int] $DockerWaitSeconds = 300,
  # The port node will bind. PORT in .env overrides it; this is only the
  # fallback for when .env does not name one, matching the app's own default.
  [int] $Port = 4400
)
. (Join-Path $PSScriptRoot 'runtime-common.ps1')

$waitForDocker = {
  param($log)
  Wait-ForgeDocker -TimeoutSeconds $DockerWaitSeconds -Log $log
}

# -Port/-EnvPortKey/-PortOwnerMustContain clear this app's own orphan off the
# listening port before starting (BLK-026). PORT in .env wins over the default,
# because node reads it from there. The fragment matches the built entry, so a
# `pnpm dev` session - which runs `--import tsx --watch src/server.ts` - is
# refused and reported rather than killed.
Invoke-ForgeApp -App 'coordinator' -Entry 'apps/coordinator/dist/server.js' -LogDir $LogDir -Runner 'run-coordinator.ps1' -BeforeStart $waitForDocker -Port $Port -EnvPortKey 'PORT' -PortOwnerMustContain @('apps/coordinator/dist/server.js')
