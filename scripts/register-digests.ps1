#requires -Version 7
<#
.SYNOPSIS
    Registers (or removes) the two Task Scheduler jobs that send TheForge
    digests at 05:00 and 17:30 local time every day (policy B12).

.DESCRIPTION
    Creates "TheForge Digest Morning" (05:00, --window=morning) and
    "TheForge Digest Evening" (17:30, --window=evening) under \TheForge\,
    each running

        pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts\run-digest.ps1 <window>

    from this checkout, as the current user. The times are the machine's
    local clock (AUS Eastern Standard Time, daylight saving applied by
    Windows), which is the same Australia/Sydney day the digest itself uses.

    Nothing runs unattended until Stage 4 is proven end to end: this script
    does not run unless an operator runs it, and -WhatIf shows exactly what it
    would register without registering anything.

.PARAMETER Unregister
    Remove the two tasks instead of creating them.

.PARAMETER RunWhenLoggedOff
    Register with logon type S4U so the tasks run whether or not the user is
    logged on. No password is stored; an S4U task has no network credentials,
    which the digest does not need (PostgreSQL, Home Assistant and SMTP are
    reached by address, not by Windows identity). Without this switch the
    tasks use the interactive logon type and run only while the user is
    logged on. To store a password instead, register by hand with
    Register-ScheduledTask -User <name> -Password <secret>.

.PARAMETER TaskPath
    Task Scheduler folder. Defaults to \TheForge\.

.EXAMPLE
    pwsh -NoProfile -File scripts/register-digests.ps1 -WhatIf
    pwsh -NoProfile -File scripts/register-digests.ps1
    pwsh -NoProfile -File scripts/register-digests.ps1 -RunWhenLoggedOff
    pwsh -NoProfile -File scripts/register-digests.ps1 -Unregister
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [switch] $Unregister,
    [switch] $RunWhenLoggedOff,
    [string] $TaskPath = '\TheForge\'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$runner = Join-Path $PSScriptRoot 'run-digest.ps1'
$pwsh = (Get-Command pwsh).Source
$user = "$env:USERDOMAIN\$env:USERNAME"

$tasks = @(
    @{ Name = 'TheForge Digest Morning'; Window = 'morning'; At = '05:00' },
    @{ Name = 'TheForge Digest Evening'; Window = 'evening'; At = '17:30' }
)

foreach ($task in $tasks) {
    $existing = Get-ScheduledTask -TaskName $task.Name -TaskPath $TaskPath -ErrorAction SilentlyContinue
    if ($Unregister) {
        if (-not $existing) {
            Write-Host "$($task.Name): not registered"
            continue
        }
        if ($PSCmdlet.ShouldProcess("$TaskPath$($task.Name)", 'Unregister-ScheduledTask')) {
            Unregister-ScheduledTask -TaskName $task.Name -TaskPath $TaskPath -Confirm:$false
            Write-Host "$($task.Name): removed"
        }
        continue
    }

    $argument = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$runner`" $($task.Window)"
    $action = New-ScheduledTaskAction -Execute $pwsh -Argument $argument -WorkingDirectory $repoRoot
    $trigger = New-ScheduledTaskTrigger -Daily -At $task.At
    # A missed run (machine asleep at 05:00) starts as soon as the machine is
    # back; a digest is bounded so a hung one cannot pile up behind the next.
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
        -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    $logonType = if ($RunWhenLoggedOff) { 'S4U' } else { 'Interactive' }
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType $logonType -RunLevel Limited

    $verb = if ($existing) { 'Replace' } else { 'Register' }
    $description = "$verb scheduled task: daily at $($task.At) local, $pwsh $argument, working directory $repoRoot, as $user ($logonType)"
    if ($PSCmdlet.ShouldProcess("$TaskPath$($task.Name)", $description)) {
        Register-ScheduledTask -TaskName $task.Name -TaskPath $TaskPath -Action $action -Trigger $trigger `
            -Settings $settings -Principal $principal -Force `
            -Description "TheForge $($task.Window) digest (policy B12): pnpm forge digest --window=$($task.Window), logged to C:\forge\logs" | Out-Null
        Write-Host "$($task.Name): registered, daily at $($task.At) as $user ($logonType)"
    }
}
