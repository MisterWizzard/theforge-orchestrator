#requires -Version 7
<#
.SYNOPSIS
    Registers (or removes) the Task Scheduler job that runs TheForge's CI
    watch every 30 minutes (policy B11, ADR-026).

.DESCRIPTION
    Creates "TheForge CI Watch" under \TheForge\, running

        pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts\run-ci-watch.ps1

    from this checkout, as the current user, every 30 minutes from the next
    half hour, indefinitely. Each run reads the Tier 0 outcome files of the
    last 48 hours, asks GitHub for the workflow runs of every merge commit and
    for the checks on every open `forge/*` pull request, and escalates a
    failure once per commit; the state file under the outbox keeps repeat
    runs quiet. Register it after the Tier 0 task, not instead of it.

    Nothing runs unattended until an operator registers it: this script does
    not run unless an operator runs it, and -WhatIf shows exactly what it
    would register without registering anything.

.PARAMETER Unregister
    Remove the task instead of creating it.

.PARAMETER RunWhenLoggedOff
    Register with logon type S4U so the task runs whether or not the user is
    logged on. No password is stored; an S4U task has no network credentials,
    which the watch does not need (GitHub is reached over HTTPS with the `gh`
    CLI's own stored login, Home Assistant and SMTP by address). Without this
    switch the task uses the interactive logon type and runs only while the
    user is logged on. To store a password instead, register by hand with
    Register-ScheduledTask -User <name> -Password <secret>.

.PARAMETER IntervalMinutes
    Minutes between runs. Defaults to 30.

.PARAMETER TaskPath
    Task Scheduler folder. Defaults to \TheForge\.

.EXAMPLE
    pwsh -NoProfile -File scripts/register-ci-watch.ps1 -WhatIf
    pwsh -NoProfile -File scripts/register-ci-watch.ps1
    pwsh -NoProfile -File scripts/register-ci-watch.ps1 -RunWhenLoggedOff
    pwsh -NoProfile -File scripts/register-ci-watch.ps1 -Unregister
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [switch] $Unregister,
    [switch] $RunWhenLoggedOff,
    [ValidateRange(5, 1440)]
    [int] $IntervalMinutes = 30,
    [string] $TaskPath = '\TheForge\'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$runner = Join-Path $PSScriptRoot 'run-ci-watch.ps1'
$pwsh = (Get-Command pwsh).Source
$user = "$env:USERDOMAIN\$env:USERNAME"
$name = 'TheForge CI Watch'
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

$argument = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$runner`""
$action = New-ForgeTaskAction -Pwsh $pwsh -Argument $argument -WorkingDirectory $repoRoot
# Start at the next whole half hour and repeat indefinitely (no
# RepetitionDuration means "for the life of the task" on Windows 10 and later).
$now = Get-Date
$start = $now.Date.AddHours($now.Hour).AddMinutes([math]::Ceiling($now.Minute / 30.0) * 30)
$trigger = New-ScheduledTaskTrigger -Once -At $start -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)
# A missed run (machine asleep) starts as soon as the machine is back; a run
# is bounded so a hung gh cannot pile up behind the next one.
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$logonType = if ($RunWhenLoggedOff) { 'S4U' } else { 'Interactive' }
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType $logonType -RunLevel Limited

$verb = if ($existing) { 'Replace' } else { 'Register' }
$description = "$verb scheduled task: every $IntervalMinutes min from $($start.ToString('HH:mm')) local, $(Get-ForgeTaskCommandText -Pwsh $pwsh -Argument $argument), working directory $repoRoot, as $user ($logonType)"
if ($PSCmdlet.ShouldProcess("$TaskPath$name", $description)) {
    Register-ScheduledTask -TaskName $name -TaskPath $TaskPath -Action $action -Trigger $trigger `
        -Settings $settings -Principal $principal -Force `
        -Description "TheForge CI watch (policy B11, ADR-026): pnpm forge ci-watch every $IntervalMinutes min, logged to C:\forge\logs" | Out-Null
    Write-Host "${name}: registered, every $IntervalMinutes min from $($start.ToString('HH:mm')) as $user ($logonType)"
}
