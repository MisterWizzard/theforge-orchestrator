#requires -Version 7
<#
.SYNOPSIS
  Run the web control centre from apps/web, logging to <LogDir>\web-<yyyyMMdd>.log.

.DESCRIPTION
  The action behind the "TheForge Web" scheduled task (register-runtime.ps1),
  and equally runnable by hand. Same contract as run-coordinator.ps1 and
  run-worker.ps1 - it builds nothing, refuses with exit 3 without .env or a
  production build, appends both output streams to the day's log, keeps the
  newest 14 daily files, and exits with node's own exit code so the watchdog
  trigger brings a crash back and leaves a clean exit alone.

  Two things differ, and are the reason Invoke-ForgeNextApp exists beside
  Invoke-ForgeApp (see runtime-common.ps1). The entry is Next's own binary
  rather than a bundled dist file, so what the pre-flight looks for is the
  apps/web/.next directory that `next build` produces; and node is started from
  apps/web, because `next start` resolves .next, next.config.ts and
  node_modules from the working directory.

  No Docker wait. Unlike the coordinator and the worker, this app touches
  neither PostgreSQL, Redis nor the sandbox: it reaches the coordinator over
  HTTP through its own /forge-api proxy and degrades gracefully when the
  coordinator is not there - /login and /forge-api/health still answer, a page
  that needs data shows its error state, and nothing crash-loops. Waiting for an
  engine it never uses would only delay the control centre an operator wants
  most when the rest of the system is unwell.

  Reaching it from elsewhere: the app stays on loopback and `tailscale serve`
  fronts it with TLS on the tailnet. That is docs/OPERATIONS.md, "Reaching the
  control centre from elsewhere", and it is also why FORGE_WEB_ORIGIN must be
  the URL the browser actually uses - the proxy refuses a mutation whose Origin
  does not match it.

  Stopping: `pnpm forge halt` stops work, but it does not stop this app; the web
  app only ever reads and forwards. `pnpm forge runtime stop` stops the task,
  and the watchdog restarts it within a minute, so unregistering is the way to
  keep it down. See docs/OPERATIONS.md "Running TheForge as a service on
  Windows".

.PARAMETER LogDir
  Where the daily log files go. Default C:\forge\logs; keep it in step with
  FORGE_LOG_DIR in .env, which is what `pnpm forge runtime status` reads.

.PARAMETER Hostname
  The address Next binds. Default 127.0.0.1, and it should stay there:
  `tailscale serve` is what exposes the app, and binding 0.0.0.0 would publish
  the control centre on the LAN as well, where nothing but the operator
  password stands in front of it.

.PARAMETER Port
  The port Next listens on. Default 3000; keep it in step with the
  `tailscale serve` target and with FORGE_WEB_PORT in .env, which is what
  `pnpm forge runtime doctor` probes.
#>
[CmdletBinding()]
param(
  [string] $LogDir = 'C:\forge\logs',
  [string] $Hostname = '127.0.0.1',
  [ValidateRange(1, 65535)]
  [int] $Port = 3000
)
. (Join-Path $PSScriptRoot 'runtime-common.ps1')

Invoke-ForgeNextApp -App 'web' -AppDir 'apps/web' -Build 'apps/web/.next' -LogDir $LogDir -Runner 'run-web.ps1' -Hostname $Hostname -Port $Port
