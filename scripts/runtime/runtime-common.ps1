#requires -Version 7
<#
.SYNOPSIS
  Functions shared by run-coordinator.ps1, run-worker.ps1 and run-web.ps1.
  Dot-sourced, never run.

.DESCRIPTION
  The three runner scripts are what Task Scheduler executes (see
  register-runtime.ps1 and docs/OPERATIONS.md "Running TheForge as a service on
  Windows"). Everything they have in common lives here: finding the repository
  root, the pre-flight that refuses to start without .env or a build, the log
  file naming and rotation, and running node with both output streams appended
  to the day's log file.

  Exit codes the runners use, so Task Scheduler's "Last Run Result" is readable:
    3  pre-flight failed (no .env, no build, node missing) - fix and start again
    4  Docker did not answer within the wait (coordinator and worker only)
    *  anything else is node's own exit code, passed through unchanged
#>
Set-StrictMode -Version Latest

$script:ForgeLogsToKeep = 14

function Get-ForgeRepoRoot {
  # This file is scripts/runtime/runtime-common.ps1; two levels up is the root.
  (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..' '..')).Path
}

function Get-ForgeLogFile {
  param(
    [Parameter(Mandatory)] [string] $App,
    [Parameter(Mandatory)] [string] $LogDir,
    [datetime] $Date = (Get-Date)
  )
  Join-Path $LogDir ('{0}-{1}.log' -f $App, $Date.ToString('yyyyMMdd'))
}

function Write-ForgeRuntimeLog {
  <#
    One line into the day's log with the same shape every time, so an operator
    tailing the file can tell the runner's own notes from the app's JSON lines.
  #>
  param(
    [Parameter(Mandatory)] [string] $LogFile,
    [Parameter(Mandatory)] [string] $Runner,
    [Parameter(Mandatory)] [string] $Message
  )
  $line = '{0} {1}: {2}' -f (Get-Date).ToString('o'), $Runner, $Message
  $line | Out-File -Append -Encoding utf8 -LiteralPath $LogFile
  # Also to the console, for an operator running the script by hand.
  Write-Host $line
}

function Remove-ForgeOldLogs {
  <#
    Keep the newest $Keep daily files for one app and delete the rest. Only
    files named exactly <app>-<yyyyMMdd>.log are candidates; the date in the
    name orders them, so a plain name sort is a date sort. Returns the names
    removed.
  #>
  param(
    [Parameter(Mandatory)] [string] $App,
    [Parameter(Mandatory)] [string] $LogDir,
    [int] $Keep = $script:ForgeLogsToKeep
  )
  if (-not (Test-Path -LiteralPath $LogDir -PathType Container)) { return @() }
  $pattern = '^{0}-\d{{8}}\.log$' -f [regex]::Escape($App)
  $stale = @(
    Get-ChildItem -LiteralPath $LogDir -File |
      Where-Object { $_.Name -match $pattern } |
      Sort-Object -Property Name -Descending |
      Select-Object -Skip $Keep
  )
  foreach ($file in $stale) { Remove-Item -LiteralPath $file.FullName -Force }
  return @($stale | ForEach-Object { $_.Name })
}

function Get-ForgePreflightProblems {
  <#
    Everything that must be true before node is started, as one message per
    problem; empty means go. These are the faults an operator fixes by hand in
    a minute, which is why each message says what to run.

    $EntryKind is what the build leaves behind: a Leaf for the coordinator and
    the worker, whose entry is one bundled file, and a Container for the web
    app, whose `next build` output is the apps/web/.next directory.
  #>
  param(
    [Parameter(Mandatory)] [string] $RepoRoot,
    [Parameter(Mandatory)] [string] $Entry,
    [ValidateSet('Leaf', 'Container')] [string] $EntryKind = 'Leaf'
  )
  $problems = @()
  $envFile = Join-Path $RepoRoot '.env'
  if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) {
    $problems += "no .env at $envFile - copy .env.example to .env and fill it in (docs/OPERATIONS.md 'Local start')"
  }
  $entryPath = Join-Path $RepoRoot $Entry
  if (-not (Test-Path -LiteralPath $entryPath -PathType $EntryKind)) {
    $problems += "no build at $entryPath - run 'corepack pnpm build' in $RepoRoot first"
  }
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    $problems += 'node is not on PATH for this session (a scheduled task sees the user PATH as it was at logon)'
  }
  return $problems
}

function Get-ForgeEnvValue {
  <#
    One value out of .env, or $null. Deliberately not a general .env parser:
    it exists so the coordinator's runner can learn the port node will bind,
    which node reads from .env itself and the runner otherwise cannot know.
    An unparseable line is skipped rather than fatal - refusing to start over
    a stray line in .env would be worse than not knowing the port.
  #>
  param(
    [Parameter(Mandatory)] [string] $RepoRoot,
    [Parameter(Mandatory)] [string] $Key
  )
  $envFile = Join-Path $RepoRoot '.env'
  if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) { return $null }
  foreach ($line in (Get-Content -LiteralPath $envFile -ErrorAction SilentlyContinue)) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
    $separator = $trimmed.IndexOf('=')
    if ($separator -lt 1) { continue }
    if ($trimmed.Substring(0, $separator).Trim() -ne $Key) { continue }
    $value = $trimmed.Substring($separator + 1).Trim().Trim('"').Trim("'")
    if ($value) { return $value }
  }
  return $null
}

function Clear-ForgeStaleListener {
  <#
    BLK-026. Free the port if - and only if - the process holding it is this
    runner's own orphan. Returns $true when the port is free or was freed, and
    $false when it is held by something this will not touch.

    The fault being repaired: `runtime stop` ends the scheduled task, but the
    runner starts node through a pipeline, so node is a child of the pwsh
    runner and Task Scheduler ends only the process it started. The node child
    survives holding its listening socket, and every start the watchdog then
    attempts dies on EADDRINUSE. The watchdog cannot recover from that on its
    own, because what holds the port is what it is trying to replace - on
    04/10/2026 it failed 210 times for the coordinator and 306 for web, once a
    minute for an hour and three quarters, while both services kept serving and
    so looked healthy. Repairing it here rather than in `stop` is deliberate:
    this covers every way an orphan can arise - a killed task, a crashed
    runner, a machine that slept - where fixing `stop` would cover only one.

    KILLING A PROCESS BY PORT IS DANGEROUS, so every condition below must hold
    and anything unrecognised is refused rather than killed:

      - exactly one process is listening (an ambiguous owner is refused);
      - it is `node`, by process name;
      - its command line contains every fragment in $CommandLineMustContain;
      - it is not this very process.

    The fragments are what make this safe in practice, because they are chosen
    to match the task's invocation and NOT a developer's. `pnpm dev` runs
    `next dev` for the web app and `--import tsx --watch src/server.ts` for the
    coordinator, while the tasks run `next start` and `dist/server.js`. So a
    dev server on the same port is refused and reported, never killed.
  #>
  param(
    [Parameter(Mandatory)] [int] $Port,
    [Parameter(Mandatory)] [string[]] $CommandLineMustContain,
    [Parameter(Mandatory)] [scriptblock] $Log
  )

  $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
  # The overwhelmingly common case: nothing there, nothing to say. Silence here
  # matters - this runs on every start, and a line per start would bury the
  # one time it has something to report.
  if ($listeners.Count -eq 0) { return $true }

  $owners = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
  if ($owners.Count -ne 1) {
    & $Log "port $Port is held by $($owners.Count) processes ($($owners -join ', ')); refusing to clear an ambiguous owner"
    return $false
  }
  $ownerId = [int] $owners[0]
  if ($ownerId -eq $PID) {
    & $Log "port $Port is held by this runner itself (pid $PID); refusing to clear"
    return $false
  }

  $owner = Get-Process -Id $ownerId -ErrorAction SilentlyContinue
  if (-not $owner) {
    & $Log "port $Port is held by pid $ownerId, which no longer exists; proceeding and letting node decide"
    return $true
  }
  if ($owner.ProcessName -ne 'node') {
    & $Log "port $Port is held by pid $ownerId ($($owner.ProcessName)), which is not node; refusing to clear"
    return $false
  }

  $commandLine = (Get-CimInstance Win32_Process -Filter "ProcessId = $ownerId" -ErrorAction SilentlyContinue).CommandLine
  if (-not $commandLine) {
    & $Log "port $Port is held by node pid $ownerId whose command line cannot be read; refusing to clear"
    return $false
  }
  # Path separators differ between the package scripts and the runners, so
  # compare on a normalised copy rather than requiring callers to guess.
  $normalised = ($commandLine -replace '\\', '/').ToLowerInvariant()
  foreach ($fragment in $CommandLineMustContain) {
    $needle = ($fragment -replace '\\', '/').ToLowerInvariant()
    if (-not $normalised.Contains($needle)) {
      & $Log "port $Port is held by node pid $ownerId, but its command line does not contain '$fragment'; refusing to clear it: $commandLine"
      return $false
    }
  }

  & $Log "port $Port is held by this app's own orphaned node pid $ownerId (started $($owner.StartTime.ToString('s'))); stopping it (BLK-026): $commandLine"
  try {
    Stop-Process -Id $ownerId -Force -ErrorAction Stop
  } catch {
    & $Log "could not stop pid ${ownerId}: $($_.Exception.Message)"
    return $false
  }

  # Windows releases the socket a moment after the process dies, so starting
  # node immediately would hit EADDRINUSE and look like the bug this fixes.
  for ($waited = 0; $waited -lt 20; $waited++) {
    Start-Sleep -Milliseconds 500
    if (@(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue).Count -eq 0) {
      & $Log "port $Port is free after stopping pid $ownerId"
      return $true
    }
  }
  & $Log "port $Port is still held 10s after stopping pid $ownerId; refusing to start"
  return $false
}

function Invoke-ForgeApp {
  <#
    Run one app from the repository root with stdout and stderr appended to
    the day's log file, and exit with node's exit code.

    The working directory is the repository root, the same directory `pnpm
    forge` runs from, so the default FORGE_WORKSPACE_ROOT, halt file and outbox
    all resolve to <root>/.forge/... and the CLI and the apps agree without
    configuration. (`pnpm dev` starts the apps from their own directories, so
    those paths differ from a `pnpm dev` session's; set absolute paths in .env
    to make every launcher agree.)

    The log file is named for the day node was started; a process that runs
    across midnight keeps writing to the same file, and the next start opens
    the new day's file. Rotation runs at every start.
  #>
  param(
    [Parameter(Mandatory)] [string] $App,
    [Parameter(Mandatory)] [string] $Entry,
    [Parameter(Mandatory)] [string] $LogDir,
    [Parameter(Mandatory)] [string] $Runner,
    # Runs after the pre-flight and before node, given a logger scriptblock;
    # returning $false exits 4 without starting (the worker's Docker wait).
    [scriptblock] $BeforeStart,
    # The port this app listens on, if it listens at all - the worker does not.
    # Given one, a stale listener left by an earlier instance is cleared before
    # node starts (BLK-026). $EnvPortKey names the .env key that overrides it,
    # because node reads the port from .env and the runner cannot otherwise
    # know which port to check.
    [int] $Port = 0,
    [string] $EnvPortKey,
    [string[]] $PortOwnerMustContain = @()
  )
  $repoRoot = Get-ForgeRepoRoot
  Set-Location -LiteralPath $repoRoot
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  $logFile = Get-ForgeLogFile -App $App -LogDir $LogDir
  $log = { param($message) Write-ForgeRuntimeLog -LogFile $logFile -Runner $Runner -Message $message }

  $problems = @(Get-ForgePreflightProblems -RepoRoot $repoRoot -Entry $Entry)
  if ($problems.Count -gt 0) {
    foreach ($problem in $problems) {
      & $log "refusing to start: $problem"
      [Console]::Error.WriteLine("${Runner}: $problem")
    }
    exit 3
  }

  if ($BeforeStart -and -not (& $BeforeStart $log)) {
    & $log 'refusing to start: the pre-start wait did not succeed (exit 4)'
    exit 4
  }

  # Immediately before node, not earlier: $BeforeStart can wait minutes for
  # Docker, and a port cleared at the start of that wait is a port something
  # else can take during it.
  if ($Port -gt 0 -and $PortOwnerMustContain.Count -gt 0) {
    $listenPort = $Port
    if ($EnvPortKey) {
      $configured = Get-ForgeEnvValue -RepoRoot $repoRoot -Key $EnvPortKey
      $parsed = 0
      if ($configured -and [int]::TryParse($configured, [ref] $parsed) -and $parsed -gt 0) {
        $listenPort = $parsed
      }
    }
    if (-not (Clear-ForgeStaleListener -Port $listenPort -CommandLineMustContain $PortOwnerMustContain -Log $log)) {
      & $log "refusing to start: port $listenPort is not available (exit 5)"
      [Console]::Error.WriteLine("${Runner}: port $listenPort is held by another process; see $logFile")
      exit 5
    }
  }

  $removed = @(Remove-ForgeOldLogs -App $App -LogDir $LogDir)
  if ($removed.Count -gt 0) { & $log ('rotated out {0}' -f ($removed -join ', ')) }
  & $log "starting node $Entry from $repoRoot (runner pid $PID)"

  # Native stderr must not be promoted to a terminating error by the
  # redirection below; node's own exit code is the only verdict that matters.
  $ErrorActionPreference = 'Continue'
  & node --env-file-if-exists=.env $Entry 2>&1 | Out-File -Append -Encoding utf8 -LiteralPath $logFile
  $code = $LASTEXITCODE
  & $log "node exited with code $code"
  exit $code
}

function Invoke-ForgeNextApp {
  <#
    Run the Next.js control centre from its own directory, with the same log
    file, rotation, pre-flight and exit-code contract as Invoke-ForgeApp: exit 3
    on a failed pre-flight, otherwise node's own exit code.

    Why this is a sibling of Invoke-ForgeApp rather than a parameter on it.
    That function is built around three things the web app cannot use: node is
    given exactly one argument (the bundled dist entry), the working directory
    is the repository root, and the build artefact is a file. `next start` takes
    its own arguments; it resolves .next, next.config.ts and node_modules from
    the working directory, so that must be apps/web; and what `next build`
    leaves behind is the .next directory. Widening Invoke-ForgeApp to an
    argument list plus a working directory plus a path kind would make the
    coordinator and the worker pay, in the one function their supervision
    depends on, for a shape only the web app has.

    The .env it reads is still the repository root's, by absolute path - the
    same file apps/web's own `start` script reaches as ../../.env - so the web
    app and the CLI read one configuration however they are started.
  #>
  param(
    [Parameter(Mandatory)] [string] $App,
    # Both relative to the repository root.
    [Parameter(Mandatory)] [string] $AppDir,
    [Parameter(Mandatory)] [string] $Build,
    [Parameter(Mandatory)] [string] $LogDir,
    [Parameter(Mandatory)] [string] $Runner,
    [Parameter(Mandatory)] [string] $Hostname,
    [Parameter(Mandatory)] [int] $Port
  )
  $repoRoot = Get-ForgeRepoRoot
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  $logFile = Get-ForgeLogFile -App $App -LogDir $LogDir
  $log = { param($message) Write-ForgeRuntimeLog -LogFile $logFile -Runner $Runner -Message $message }

  $problems = @(Get-ForgePreflightProblems -RepoRoot $repoRoot -Entry $Build -EntryKind 'Container')
  if ($problems.Count -gt 0) {
    foreach ($problem in $problems) {
      & $log "refusing to start: $problem"
      [Console]::Error.WriteLine("${Runner}: $problem")
    }
    exit 3
  }

  $workingDir = Join-Path $repoRoot $AppDir
  Set-Location -LiteralPath $workingDir
  $envFile = Join-Path $repoRoot '.env'
  $next = Join-Path 'node_modules' 'next' 'dist' 'bin' 'next'

  # Same as Invoke-ForgeApp: clear this app's own orphan off the port before
  # starting, and refuse rather than kill anything else (BLK-026). The web app
  # knows its port already - it passes it to next - so there is no .env to read.
  # The fragments match `next start`, which is what the task runs; `pnpm dev`
  # runs `next dev` and is therefore refused and reported, not killed.
  if (-not (Clear-ForgeStaleListener -Port $Port -CommandLineMustContain @('next/dist/bin/next', ' start ') -Log $log)) {
    & $log "refusing to start: port $Port is not available (exit 5)"
    [Console]::Error.WriteLine("${Runner}: port $Port is held by another process; see $logFile")
    exit 5
  }

  $removed = @(Remove-ForgeOldLogs -App $App -LogDir $LogDir)
  if ($removed.Count -gt 0) { & $log ('rotated out {0}' -f ($removed -join ', ')) }
  & $log "starting node $next start -H $Hostname -p $Port from $workingDir (runner pid $PID)"

  # Native stderr must not be promoted to a terminating error by the
  # redirection below; node's own exit code is the only verdict that matters.
  $ErrorActionPreference = 'Continue'
  & node "--env-file-if-exists=$envFile" $next start -H $Hostname -p $Port 2>&1 |
    Out-File -Append -Encoding utf8 -LiteralPath $logFile
  $code = $LASTEXITCODE
  & $log "node exited with code $code"
  exit $code
}

function Wait-ForgeDocker {
  <#
    True once `docker info` succeeds, polling until the timeout. Docker Desktop
    starts with the user's session and the worker needs the engine (and the
    sandbox image) before it can run anything, so the worker runner waits here
    rather than failing and burning a restart.
  #>
  param(
    [int] $TimeoutSeconds = 300,
    [int] $PollSeconds = 10,
    [scriptblock] $Log = { param($message) Write-Host $message }
  )
  $docker = Get-Command docker -ErrorAction SilentlyContinue
  $dockerPath = if ($docker) { $docker.Source } else { 'C:\Program Files\Docker\Docker\resources\bin\docker.exe' }
  if (-not (Test-Path -LiteralPath $dockerPath -PathType Leaf)) {
    & $Log "docker is not on PATH and $dockerPath does not exist"
    return $false
  }
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $attempt = 0
  while ($true) {
    $attempt += 1
    $ErrorActionPreference = 'Continue'
    & $dockerPath info *> $null
    if ($LASTEXITCODE -eq 0) {
      & $Log "docker answered on attempt $attempt"
      return $true
    }
    if ((Get-Date) -ge $deadline) {
      & $Log "docker did not answer within ${TimeoutSeconds}s ($attempt attempts)"
      return $false
    }
    & $Log "docker not ready (attempt $attempt); retrying in ${PollSeconds}s"
    Start-Sleep -Seconds $PollSeconds
  }
}
