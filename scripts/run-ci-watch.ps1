#requires -Version 7
<#
.SYNOPSIS
    Runs one TheForge CI watch for Task Scheduler and logs it (policy B11, ADR-026).

.DESCRIPTION
    Changes to the repository root (so `pnpm forge` finds .env), runs
    `corepack pnpm forge ci-watch --hours=<Hours>`, appends everything the
    command prints to <LogDir>\ci-watch-<yyyyMMdd>.log and exits with the
    command's own exit code: 0 nothing failed or every escalation went out,
    1 a GitHub call or a channel failed, 2 usage or configuration.
    scripts/register-ci-watch.ps1 points the scheduled task at this file;
    run it by hand the same way to test the wiring.

    The command needs the `gh` CLI on PATH and signed in as the task user; it
    never handles a token itself.

.PARAMETER Hours
    How far back to read Tier 0 outcome files for merges to watch. Defaults
    to 48, which is the command's own default.

.PARAMETER LogDir
    Where the log goes. Defaults to $env:FORGE_CI_WATCH_LOG_DIR, else
    $env:FORGE_DIGEST_LOG_DIR, else C:\forge\logs. Created if missing.

.PARAMETER DryRun
    Passes --dry-run: prints what would be escalated without sending anything
    or writing the state file.

.EXAMPLE
    pwsh -NoProfile -File scripts/run-ci-watch.ps1
    pwsh -NoProfile -File scripts/run-ci-watch.ps1 -DryRun -LogDir $env:TEMP
#>
[CmdletBinding()]
param(
    [ValidateRange(1, 8760)]
    [int] $Hours = 48,

    [string] $LogDir = $(
        if ($env:FORGE_CI_WATCH_LOG_DIR) { $env:FORGE_CI_WATCH_LOG_DIR }
        elseif ($env:FORGE_DIGEST_LOG_DIR) { $env:FORGE_DIGEST_LOG_DIR }
        else { 'C:\forge\logs' }
    ),

    [switch] $DryRun
)

$ErrorActionPreference = 'Continue'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$log = Join-Path $LogDir ("ci-watch-{0}.log" -f (Get-Date -Format 'yyyyMMdd'))
$stamp = { Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz' }

# Task Scheduler starts pwsh with the task user's persisted PATH, which is
# where node, corepack and gh live on this machine; a missing one is the
# first thing worth knowing, so say so in the log rather than failing on a
# bare command name.
$corepack = Get-Command corepack -ErrorAction SilentlyContinue
if (-not $corepack) {
    Add-Content -LiteralPath $log -Value "[$(& $stamp)] forge ci-watch: corepack is not on PATH for $env:USERNAME; install Node.js for this user or add it to PATH"
    exit 2
}
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    Add-Content -LiteralPath $log -Value "[$(& $stamp)] forge ci-watch: gh is not on PATH for $env:USERNAME; install GitHub CLI for this user and run gh auth login"
    exit 2
}

$arguments = @('pnpm', 'forge', 'ci-watch', "--hours=$Hours")
if ($DryRun) { $arguments += '--dry-run' }

Add-Content -LiteralPath $log -Value "[$(& $stamp)] forge ci-watch --hours=$Hours$(if ($DryRun) { ' --dry-run' }) (cwd $repoRoot, user $env:USERNAME)"
# stderr merged in, every line to the log and to the console (for a hand run).
& $corepack.Source @arguments 2>&1 | ForEach-Object { "$_" } | Tee-Object -FilePath $log -Append
# A pipeline that never reached the command leaves no exit code; that is a failure, not a success.
$code = if ($null -eq $LASTEXITCODE) { 1 } else { $LASTEXITCODE }
Add-Content -LiteralPath $log -Value "[$(& $stamp)] exit $code"
exit $code
