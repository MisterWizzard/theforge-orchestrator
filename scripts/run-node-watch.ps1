#requires -Version 7
<#
.SYNOPSIS
    Runs one TheForge tailnet node watch for Task Scheduler and logs it (ADR-031).

.DESCRIPTION
    Changes to the repository root (so `pnpm forge` finds .env), runs
    `corepack pnpm forge node-watch`, appends everything the command prints to
    <LogDir>\node-watch-<yyyyMMdd>.log and exits with the command's own exit
    code: 0 nothing changed or every escalation went out, 1 the tailscale call
    or a channel failed, 2 usage. scripts/register-node-watch.ps1 points the
    scheduled task at this file; run it by hand the same way to test the wiring.

    Which nodes are watched comes from FORGE_WATCH_NODES (comma separated short
    names) or -Node; with neither, every node on the tailnet is watched, because
    a node appearing that Dan does not know about is one of the things worth
    hearing about. The command finds `tailscale` on PATH, or at
    C:\Program Files\Tailscale\tailscale.exe when a scheduled task's PATH does
    not have it, so this script does not insist on the bare name being there.

.PARAMETER Node
    Short node names to watch, overriding FORGE_WATCH_NODES. Repeatable:
    -Node noded,nodec.

.PARAMETER LogDir
    Where the log goes. Defaults to $env:FORGE_NODE_WATCH_LOG_DIR, else
    $env:FORGE_DIGEST_LOG_DIR, else C:\forge\logs. Created if missing.

.PARAMETER DryRun
    Passes --dry-run: prints what would be escalated without sending anything
    or writing the state file.

.EXAMPLE
    pwsh -NoProfile -File scripts/run-node-watch.ps1
    pwsh -NoProfile -File scripts/run-node-watch.ps1 -Node noded,nodec
    pwsh -NoProfile -File scripts/run-node-watch.ps1 -DryRun -LogDir $env:TEMP
#>
[CmdletBinding()]
param(
    [string[]] $Node = @(),

    [string] $LogDir = $(
        if ($env:FORGE_NODE_WATCH_LOG_DIR) { $env:FORGE_NODE_WATCH_LOG_DIR }
        elseif ($env:FORGE_DIGEST_LOG_DIR) { $env:FORGE_DIGEST_LOG_DIR }
        else { 'C:\forge\logs' }
    ),

    [switch] $DryRun
)

$ErrorActionPreference = 'Continue'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$log = Join-Path $LogDir ("node-watch-{0}.log" -f (Get-Date -Format 'yyyyMMdd'))
$stamp = { Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz' }

# Task Scheduler starts pwsh with the task user's persisted PATH, which is
# where node and corepack live on this machine; a missing one is the first
# thing worth knowing, so say so in the log rather than failing on a bare
# command name. tailscale is deliberately NOT checked here: the command falls
# back to the installed path itself.
$corepack = Get-Command corepack -ErrorAction SilentlyContinue
if (-not $corepack) {
    Add-Content -LiteralPath $log -Value "[$(& $stamp)] forge node-watch: corepack is not on PATH for $env:USERNAME; install Node.js for this user or add it to PATH"
    exit 2
}

$arguments = @('pnpm', 'forge', 'node-watch')
# With `pwsh -File`, -Node noded,nodec arrives as one string, so split as well as flatten.
foreach ($name in ($Node | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })) {
    $arguments += "--node=$name"
}
if ($DryRun) { $arguments += '--dry-run' }

$shown = ($arguments[2..($arguments.Count - 1)] -join ' ')
Add-Content -LiteralPath $log -Value "[$(& $stamp)] forge $shown (cwd $repoRoot, user $env:USERNAME)"
# stderr merged in, every line to the log and to the console (for a hand run).
& $corepack.Source @arguments 2>&1 | ForEach-Object { "$_" } | Tee-Object -FilePath $log -Append
# A pipeline that never reached the command leaves no exit code; that is a failure, not a success.
$code = if ($null -eq $LASTEXITCODE) { 1 } else { $LASTEXITCODE }
Add-Content -LiteralPath $log -Value "[$(& $stamp)] exit $code"
exit $code
