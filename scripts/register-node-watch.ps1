#requires -Version 7
<#
.SYNOPSIS
    Registers (or removes) the Task Scheduler job that runs TheForge's tailnet
    node watch every 15 minutes (ADR-031).

.DESCRIPTION
    Creates "TheForge Node Watch" under \TheForge\, running

        pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts\run-node-watch.ps1

    from this checkout, as the current user, every 15 minutes from the next
    quarter hour, indefinitely. Each run reads `tailscale status --json` and
    compares it with <outbox>\node-watch\state.json: a watched node that has
    come back online is a warn (so it reaches the phone), one that has gone
    offline is an info, and one the state file has never held is a warn. The
    state file keeps repeat runs quiet.

    Nothing runs unattended until an operator registers it: this script does
    not run unless an operator runs it, and -WhatIf shows exactly what it
    would register without registering anything.

.PARAMETER Unregister
    Remove the task instead of creating it.

.PARAMETER RunWhenLoggedOff
    Register with logon type S4U so the task runs whether or not the user is
    logged on. No password is stored; an S4U task has no network credentials,
    which the watch does not need (tailscale is asked over its local API by the
    CLI, Home Assistant and SMTP are reached by address). Without this switch
    the task uses the interactive logon type and runs only while the user is
    logged on. To store a password instead, register by hand with
    Register-ScheduledTask -User <name> -Password <secret>.

.PARAMETER IntervalMinutes
    Minutes between runs. Defaults to 15: often enough that a node coming back
    is news within the quarter hour, cheap enough that it is one local call.

.PARAMETER Node
    Short node names to watch, passed to the runner as --node and overriding
    FORGE_WATCH_NODES for this task. With neither, every node is watched.

.PARAMETER TaskPath
    Task Scheduler folder. Defaults to \TheForge\.

.EXAMPLE
    pwsh -NoProfile -File scripts/register-node-watch.ps1 -WhatIf
    pwsh -NoProfile -File scripts/register-node-watch.ps1
    pwsh -NoProfile -File scripts/register-node-watch.ps1 -Node noded,nodec
    pwsh -NoProfile -File scripts/register-node-watch.ps1 -RunWhenLoggedOff
    pwsh -NoProfile -File scripts/register-node-watch.ps1 -Unregister
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [switch] $Unregister,
    [switch] $RunWhenLoggedOff,
    [ValidateRange(5, 1440)]
    [int] $IntervalMinutes = 15,
    [string[]] $Node = @(),
    [string] $TaskPath = '\TheForge\'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$runner = Join-Path $PSScriptRoot 'run-node-watch.ps1'
$pwsh = (Get-Command pwsh).Source
$user = "$env:USERDOMAIN\$env:USERNAME"
$name = 'TheForge Node Watch'
. (Join-Path $PSScriptRoot 'runtime' 'task-action.ps1')

$existing = Get-ScheduledTask -TaskName $name -TaskPath $TaskPath -ErrorAction SilentlyContinue
if ($Unregister) {
    if (-not $existing) {
        Write-Host "${name}: not registered"
        return
    }
    if ($PSCmdlet.ShouldProcess("$TaskPath$name", 'Unregister-ScheduledTask')) {
        Unregister-ScheduledTask -TaskName $name -TaskPath $TaskPath -Confirm:$false
        Write-Host "${name}: removed"
    }
    return
}

# With `pwsh -File`, -Node noded,nodec arrives as one string, so split as well as flatten.
$watched = @($Node | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
foreach ($candidate in $watched) {
    if ($candidate -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') {
        throw "-Node '$candidate' is not a short node name (letters, digits, dot, dash, underscore)"
    }
}
$runnerArguments = if ($watched.Count) { " -Node $($watched -join ',')" } else { '' }
$argument = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$runner`"$runnerArguments"
$action = New-ForgeTaskAction -Pwsh $pwsh -Argument $argument -WorkingDirectory $repoRoot
# Start at the next whole quarter hour and repeat indefinitely (no
# RepetitionDuration means "for the life of the task" on Windows 10 and later).
$now = Get-Date
$start = $now.Date.AddHours($now.Hour).AddMinutes([math]::Ceiling($now.Minute / 15.0) * 15)
$trigger = New-ScheduledTaskTrigger -Once -At $start -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)
# A missed run (machine asleep) starts as soon as the machine is back; a run
# is bounded so a hung tailscale cannot pile up behind the next one.
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$logonType = if ($RunWhenLoggedOff) { 'S4U' } else { 'Interactive' }
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType $logonType -RunLevel Limited

$verb = if ($existing) { 'Replace' } else { 'Register' }
$watchedText = if ($watched.Count) { $watched -join ', ' } else { 'every node (FORGE_WATCH_NODES, else all)' }
$description = "$verb scheduled task: every $IntervalMinutes min from $($start.ToString('HH:mm')) local, $(Get-ForgeTaskCommandText -Pwsh $pwsh -Argument $argument), working directory $repoRoot, as $user ($logonType), watching $watchedText"
if ($PSCmdlet.ShouldProcess("$TaskPath$name", $description)) {
    Register-ScheduledTask -TaskName $name -TaskPath $TaskPath -Action $action -Trigger $trigger `
        -Settings $settings -Principal $principal -Force `
        -Description "TheForge tailnet node watch (ADR-031): pnpm forge node-watch every $IntervalMinutes min, watching $watchedText, logged to C:\forge\logs" | Out-Null
    Write-Host "${name}: registered, every $IntervalMinutes min from $($start.ToString('HH:mm')) as $user ($logonType), watching $watchedText"
}
