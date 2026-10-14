#requires -Version 7
<#
.SYNOPSIS
  Register (or remove) the "TheForge Coordinator", "TheForge Worker" and
  "TheForge Web" scheduled tasks.

.DESCRIPTION
  Creates three Task Scheduler tasks that run run-coordinator.ps1, run-worker.ps1
  and run-web.ps1 under the current user's interactive session:

    trigger        at log on of the current user (the worker with a 30 s delay)
    watchdog       a second trigger every -WatchdogMinutes (default 1), forever
    on failure     restart every 1 minute, up to 999 times
    time limit     none (ExecutionTimeLimit PT0S)
    instances      IgnoreNew - a second start while one runs is ignored
    principal      the current user, "run only when user is logged on", not elevated
    working dir    the repository root

  The watchdog trigger exists because the "on failure, restart" settings do not
  actually restart these tasks. Measured on 27/09/2026 during the S5.3 restart
  test: the coordinator process was killed mid-run, run-coordinator.ps1 exited
  -1, and the task recorded LastTaskResult 0xFFFFFFFF with RestartCount 999 and
  RestartInterval PT1M both set - yet Task Scheduler left it Ready with no next
  run, so nothing came back. Recorded as BLK-017. A repeating Once trigger does
  not rely on that machinery at all: while the task runs, IgnoreNew makes each
  repeat a no-op; once the process has died, the next repeat starts it again.
  The same pattern already supervises the CI watch task.

  Consequence worth knowing: because the watchdog fires about a minute after
  registration, these tasks now self-start rather than waiting for
  `pnpm forge runtime start` or the next logon, and `pnpm forge runtime stop`
  is undone by the watchdog within a minute. The durable way to stop work is
  the kill switch - `pnpm forge halt` writes FORGE_HALT and the runners refuse
  to lease anything while it exists - which is by design the single source of
  truth. Pass -NoWatchdog for the previous start-only-on-demand behaviour.

  "Run only when user is logged on" is deliberate: Docker Desktop is per-user
  and the worker needs its engine, and the interactive session keeps the user
  PATH (node, docker, pwsh) that the runners rely on. The alternative, "run
  whether user is logged on or not", would need a stored password (LogonType
  Password) and a Docker engine that runs without a session; neither is set up
  here. Auto-logon plus a locked screen is necessary but NOT sufficient: Docker
  Desktop must also be set to start when the user signs in, or a reboot leaves
  both apps waiting for an engine that never arrives (BLK-019).

  Registration is idempotent (-Force replaces an existing task of the same
  name). Before registering, `pnpm forge runtime doctor` must pass; -SkipDoctor
  overrides that for a deliberately partial setup.

  Policy: nothing is registered until Stage 4 is proven end to end. This script
  is the mechanism; running it is a Dan-only manual action recorded in
  docs/OPERATIONS.md.

.PARAMETER Unregister
  Stop and remove all three tasks instead of creating them.

.PARAMETER LogDir
  Passed to the runners as -LogDir. Default C:\forge\logs.

.PARAMETER SkipDoctor
  Register even if `pnpm forge runtime doctor` reports a FAIL.

.PARAMETER WatchdogMinutes
  How often the watchdog trigger re-fires, in minutes. Default 1.

.PARAMETER NoWatchdog
  Register with the logon trigger only, so a dead process is not revived. Use
  this only when you want the process lifetime under your own control; it
  reinstates the BLK-017 behaviour, where a killed coordinator stays dead.

.EXAMPLE
  pwsh -NoProfile -File scripts/runtime/register-runtime.ps1 -WhatIf
  Shows what would be registered, without registering.

.EXAMPLE
  pwsh -NoProfile -File scripts/runtime/register-runtime.ps1
  Registers all three tasks. Then: pnpm forge runtime status

.EXAMPLE
  pwsh -NoProfile -File scripts/runtime/register-runtime.ps1 -Unregister
  Stops and removes all three tasks.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
  [switch] $Unregister,
  # Which apps to act on. Omitted means all three. Added 28/09/2026 because the
  # all-or-nothing behaviour made this script unusable once the runtime was up:
  # registering TheForge Web while the coordinator was running failed with
  # "Access is denied" on the FIRST task and therefore registered nothing at all,
  # and there was no way to ask for just the one that was missing.
  [ValidateSet('coordinator', 'worker', 'web')]
  [string[]] $App,
  [string] $LogDir = 'C:\forge\logs',
  [switch] $SkipDoctor,
  [ValidateRange(1, 60)]
  [int] $WatchdogMinutes = 1,
  [switch] $NoWatchdog
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..' '..')).Path
$pwsh = Join-Path $PSHOME 'pwsh.exe'
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
. (Join-Path $PSScriptRoot 'task-action.ps1')

$tasks = @(
  [pscustomobject]@{
    Key         = 'coordinator'
    Name        = 'TheForge Coordinator'
    Script      = Join-Path $repoRoot 'scripts\runtime\run-coordinator.ps1'
    Delay       = $null
    Description = 'TheForge coordinator (apps/coordinator) as a supervised service. Logs: <LogDir>\coordinator-<yyyyMMdd>.log. Stop safely with "pnpm forge runtime stop".'
  },
  [pscustomobject]@{
    Key         = 'worker'
    Name        = 'TheForge Worker'
    Script      = Join-Path $repoRoot 'scripts\runtime\run-worker.ps1'
    Delay       = 'PT30S'
    Description = 'TheForge worker (apps/worker) as a supervised service; waits for Docker before starting. Logs: <LogDir>\worker-<yyyyMMdd>.log. Stop safely with "pnpm forge runtime stop".'
  },
  # No Docker wait for the web app, deliberately: it holds no PostgreSQL or
  # Redis connection and runs nothing in the sandbox. It reaches the coordinator
  # over HTTP through its own /forge-api proxy and degrades gracefully when the
  # coordinator is absent, so waiting for an engine it never uses would only
  # delay the control centre at the moment an operator most wants it. The
  # coordinator's and the worker's waits are BLK-019; this task needs none, and
  # for the same reason it needs no start delay.
  [pscustomobject]@{
    Key         = 'web'
    Name        = 'TheForge Web'
    Script      = Join-Path $repoRoot 'scripts\runtime\run-web.ps1'
    Delay       = $null
    Description = 'TheForge web control centre (apps/web) as a supervised service, on loopback with tailscale serve in front. Logs: <LogDir>\web-<yyyyMMdd>.log. Stop safely with "pnpm forge runtime stop".'
  }
)

if ($App) {
  $tasks = @($tasks | Where-Object { $App -contains $_.Key })
  if (-not $tasks) { throw "no tasks matched -App $($App -join ',')" }
  Write-Host "acting on: $(($tasks | ForEach-Object { $_.Name }) -join ', ')"
}

if ($Unregister) {
  foreach ($task in $tasks) {
    $existing = Get-ScheduledTask -TaskName $task.Name -ErrorAction SilentlyContinue
    if (-not $existing) {
      Write-Host "$($task.Name): not registered"
      continue
    }
    if ($PSCmdlet.ShouldProcess($task.Name, 'Stop and unregister scheduled task')) {
      if ($existing.State -eq 'Running') { Stop-ScheduledTask -TaskName $task.Name }
      Unregister-ScheduledTask -TaskName $task.Name -Confirm:$false
      Write-Host "$($task.Name): unregistered"
    }
  }
  exit 0
}

foreach ($task in $tasks) {
  if (-not (Test-Path -LiteralPath $task.Script -PathType Leaf)) {
    throw "runner script missing: $($task.Script)"
  }
}

if (-not $SkipDoctor) {
  Write-Host "pre-flight: corepack pnpm forge runtime doctor (in $repoRoot)"
  Push-Location -LiteralPath $repoRoot
  try {
    # pnpm writes progress to stderr; only the exit code is the verdict.
    $ErrorActionPreference = 'Continue'
    & corepack pnpm forge runtime doctor
    $doctorExit = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = 'Stop'
    Pop-Location
  }
  if ($doctorExit -ne 0) {
    throw "runtime doctor reported a FAIL (exit $doctorExit); fix it, or pass -SkipDoctor to register anyway"
  }
}

$settings = New-ScheduledTaskSettingsSet `
  -MultipleInstances IgnoreNew `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited

foreach ($task in $tasks) {
  $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -LogDir "{1}"' -f $task.Script, $LogDir
  $action = New-ForgeTaskAction -Pwsh $pwsh -Argument $arguments -WorkingDirectory $repoRoot
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
  if ($task.Delay) { $trigger.Delay = $task.Delay }
  # The watchdog: a Once trigger with a repetition and no duration repeats for
  # the life of the task on Windows 10 and later. IgnoreNew makes each repeat a
  # no-op while the process is alive, so this only ever revives a dead one.
  $triggers = @($trigger)
  if (-not $NoWatchdog) {
    $triggers += New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes($WatchdogMinutes) `
      -RepetitionInterval (New-TimeSpan -Minutes $WatchdogMinutes)
  }

  Write-Host ''
  Write-Host "task:        $($task.Name)"
  Write-Host "execute:     $(Get-ForgeTaskCommandText -Pwsh $pwsh -Argument $arguments)"
  Write-Host "working dir: $repoRoot"
  Write-Host "trigger:     at log on of $user$(if ($task.Delay) { " (delay $($task.Delay))" })"
  Write-Host "watchdog:    $(if ($NoWatchdog) { 'none (-NoWatchdog): a dead process stays dead' } else { "every $WatchdogMinutes min, forever; revives a dead process (BLK-017)" })"
  Write-Host "settings:    restart every $($settings.RestartInterval) up to $($settings.RestartCount) times, time limit $($settings.ExecutionTimeLimit) (none), instances $($settings.MultipleInstances)"
  Write-Host "principal:   $user, $($principal.LogonType) (run only when logged on), $($principal.RunLevel)"

  if ($PSCmdlet.ShouldProcess($task.Name, 'Register scheduled task')) {
    # -Force alone is not enough: replacing a task that is currently Running fails with
    # "Access is denied" (measured 28/09/2026 on TheForge Coordinator). Stop it first. The
    # watchdog trigger restarts it within $WatchdogMinutes, so this is a brief gap rather
    # than a shutdown - and a resumed run waits for a worker by ADR-029.
    $running = Get-ScheduledTask -TaskName $task.Name -ErrorAction SilentlyContinue
    if ($running -and $running.State -eq 'Running') {
      Write-Host "note:        stopping the running task first so it can be replaced"
      Stop-ScheduledTask -TaskName $task.Name
      Start-Sleep -Seconds 2
    }
    Register-ScheduledTask `
      -TaskName $task.Name `
      -Description $task.Description `
      -Action $action `
      -Trigger $triggers `
      -Settings $settings `
      -Principal $principal `
      -Force | Out-Null
    Write-Host "registered:  $($task.Name) ($((Get-ScheduledTask -TaskName $task.Name).State))"
  }
}

Write-Host ''
if ($NoWatchdog) {
  Write-Host 'Nothing has been started. Next: pnpm forge runtime status; pnpm forge runtime start when Stage 4 allows it.'
} else {
  Write-Host "The watchdog starts every task within $WatchdogMinutes min and revives them if they die."
  Write-Host 'Next: pnpm forge runtime status. To stop work durably use pnpm forge halt, not runtime stop.'
}
