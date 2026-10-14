#requires -Version 7
<#
.SYNOPSIS
  New-ForgeTaskAction: the scheduled-task action every register-*.ps1 script uses.
  Dot-sourced, never run.

.DESCRIPTION
  A task that starts pwsh directly under the interactive logon type gets a
  console window. On Windows 11, with the default terminal left on "Let
  Windows decide", that is a Windows Terminal window: the watch tasks flash one
  every run, and the three runtime tasks leave one open for as long as node
  runs, from logon onwards. -WindowStyle Hidden does not help, because the
  window exists before pwsh can hide it.

  When run-hidden.exe is installed, the action starts pwsh through it instead.
  run-hidden is a GUI-subsystem launcher that creates the process with
  CREATE_NO_WINDOW: pwsh and everything it starts still have a console, so
  output and child processes behave as before, but no window is ever shown.
  It waits for pwsh and exits with pwsh's own exit code, so Task Scheduler's
  Last Run Result, which `pnpm forge runtime status` and the task-health checks
  read, stays meaningful. `conhost.exe --headless` would also hide the window,
  but it always exits 0, so it is deliberately not used here.

  run-hidden.exe is found at $env:FORGE_RUN_HIDDEN, else
  %LOCALAPPDATA%\Programs\run-hidden\run-hidden.exe. Without it the action
  falls back to plain pwsh, and the task works as it always did, window and all.
#>

function Get-ForgeRunHidden {
  $path = if ($env:FORGE_RUN_HIDDEN) { $env:FORGE_RUN_HIDDEN }
          else { Join-Path $env:LOCALAPPDATA 'Programs\run-hidden\run-hidden.exe' }
  if (Test-Path -LiteralPath $path -PathType Leaf) { $path } else { $null }
}

function New-ForgeTaskAction {
  param(
    [Parameter(Mandatory)] [string] $Pwsh,
    [Parameter(Mandatory)] [string] $Argument,
    [Parameter(Mandatory)] [string] $WorkingDirectory
  )
  $runHidden = Get-ForgeRunHidden
  if ($runHidden) {
    New-ScheduledTaskAction -Execute $runHidden -Argument "`"$Pwsh`" $Argument" -WorkingDirectory $WorkingDirectory
  } else {
    Write-Warning "run-hidden.exe not found; the task will open a visible console window (see scripts/runtime/task-action.ps1)"
    New-ScheduledTaskAction -Execute $Pwsh -Argument $Argument -WorkingDirectory $WorkingDirectory
  }
}

function Get-ForgeTaskCommandText {
  # The command line as the task will run it, for the -WhatIf and confirmation text.
  param(
    [Parameter(Mandatory)] [string] $Pwsh,
    [Parameter(Mandatory)] [string] $Argument
  )
  $runHidden = Get-ForgeRunHidden
  if ($runHidden) { "$runHidden `"$Pwsh`" $Argument" } else { "$Pwsh $Argument" }
}
