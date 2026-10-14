#requires -Version 7
<#
.SYNOPSIS
    Runs one TheForge digest for Task Scheduler and logs it (policy B12).

.DESCRIPTION
    Changes to the repository root (so `pnpm forge` finds .env), runs
    `corepack pnpm forge digest --window=<Window>`, appends everything the
    command prints to <LogDir>\digest-<yyyyMMdd>.log and exits with the
    command's own exit code: 0 sent, 1 a channel failed, 2 usage or
    configuration. scripts/register-digests.ps1 points the two scheduled
    tasks at this file; run it by hand the same way to test the wiring.

.PARAMETER Window
    morning (previous local day 17:30 -> now), evening (today 05:00 -> now)
    or now (the last twelve hours).

.PARAMETER LogDir
    Where the log goes. Defaults to $env:FORGE_DIGEST_LOG_DIR, else C:\forge\logs.
    Created if missing.

.PARAMETER DryRun
    Passes --dry-run: renders and logs the digest without sending it.

.EXAMPLE
    pwsh -NoProfile -File scripts/run-digest.ps1 morning
    pwsh -NoProfile -File scripts/run-digest.ps1 now -DryRun -LogDir $env:TEMP
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet('morning', 'evening', 'now')]
    [string] $Window,

    [string] $LogDir = $(if ($env:FORGE_DIGEST_LOG_DIR) { $env:FORGE_DIGEST_LOG_DIR } else { 'C:\forge\logs' }),

    [switch] $DryRun,

    # Seconds to wait for the Docker engine before giving up. The digest reads
    # PostgreSQL, which runs in Docker, so without this it fails whenever the task
    # fires before the engine is ready - see the note by Wait-ForgeDocker below.
    [int] $DockerWaitSeconds = 300
)

$ErrorActionPreference = 'Continue'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$log = Join-Path $LogDir ("digest-{0}.log" -f (Get-Date -Format 'yyyyMMdd'))
$stamp = { Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz' }

# Task Scheduler starts pwsh with the task user's persisted PATH, which is
# where node and corepack live on this machine; a missing corepack is the
# first thing worth knowing, so say so in the log rather than failing on a
# bare command name.
$corepack = Get-Command corepack -ErrorAction SilentlyContinue
if (-not $corepack) {
    Add-Content -LiteralPath $log -Value "[$(& $stamp)] forge digest --window=${Window}: corepack is not on PATH for $env:USERNAME; install Node.js for this user or add it to PATH"
    exit 2
}

# Wait for the Docker engine, because the digest reads PostgreSQL and PostgreSQL runs
# in Docker. Measured 04/10/2026: the 06:00 morning digest failed with
# "could not read the database:" seconds after the machine resumed, because the task
# fired before the engine was up. The coordinator and worker runners have waited here
# since BLK-019; this one never did, and its failure was silent until the digest began
# reporting failing tasks (ADR-033) and pointed at itself.
#
# A dry run still waits: a dry run that cannot read the database proves nothing.
. (Join-Path $PSScriptRoot 'runtime' 'runtime-common.ps1')
$logLine = { param($message) Add-Content -LiteralPath $log -Value "[$(& $stamp)] $message" }
if (-not (Wait-ForgeDocker -TimeoutSeconds $DockerWaitSeconds -Log $logLine)) {
    & $logLine "forge digest --window=${Window}: Docker did not become ready within ${DockerWaitSeconds}s; not running"
    exit 4
}

$arguments = @('pnpm', 'forge', 'digest', "--window=$Window")
if ($DryRun) { $arguments += '--dry-run' }

Add-Content -LiteralPath $log -Value "[$(& $stamp)] forge digest --window=$Window$(if ($DryRun) { ' --dry-run' }) (cwd $repoRoot, user $env:USERNAME)"
# stderr merged in, every line to the log and to the console (for a hand run).
& $corepack.Source @arguments 2>&1 | ForEach-Object { "$_" } | Tee-Object -FilePath $log -Append
# A pipeline that never reached the command leaves no exit code; that is a failure, not a success.
$code = if ($null -eq $LASTEXITCODE) { 1 } else { $LASTEXITCODE }
Add-Content -LiteralPath $log -Value "[$(& $stamp)] exit $code"
exit $code
