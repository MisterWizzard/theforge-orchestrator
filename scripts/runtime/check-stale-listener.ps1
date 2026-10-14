<#
  .SYNOPSIS
    Manual check for Clear-ForgeStaleListener (BLK-026).

  .DESCRIPTION
    Clear-ForgeStaleListener kills a process by port, so it is the most
    dangerous function in this directory and the only one with no automated
    coverage: the repository has no PowerShell test harness, and CI's portable
    job cannot provide one (it needs Windows, a free port, and the right to
    spawn and kill processes). This script is that coverage, run by hand.

    Six cases on a spare port, so the running services are untouched. Three
    must clear and three must refuse:

      D  nothing listening                      -> true, and silent
      A  node, command line matches             -> cleared and killed
      C  node, command line does not match      -> refused, left alive
      B  a listener that is not node            -> refused, left alive
      E  node as `next start` (the web task)    -> cleared and killed
      F  node as `next dev` (a developer)       -> refused, left alive

    C and F are the ones that matter. A function that kills by port is only
    safe if it refuses everything it cannot positively identify, and F is the
    realistic accident: a developer's `pnpm dev` on the same port must survive.

  .EXAMPLE
    pwsh -NoProfile -File scripts/runtime/check-stale-listener.ps1

    Exits 0 when all eleven assertions pass, 1 otherwise. Needs node and
    python on PATH.
#>
[CmdletBinding()]
param(
  # Any free port; 45321 is arbitrary and deliberately not one of ours.
  [int] $ProbePort = 45321
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'runtime-common.ps1')

$port = $ProbePort
$log = { param($m) Write-Host "    log| $m" }
$results = @()

function Wait-Listening {
  param([int] $Port, [int] $Seconds = 10)
  for ($i = 0; $i -lt ($Seconds * 2); $i++) {
    if (@(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue).Count -gt 0) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

function Stop-Quietly {
  param($Proc)
  if ($Proc -and -not $Proc.HasExited) { Stop-Process -Id $Proc.Id -Force -ErrorAction SilentlyContinue }
}

$listenScript = "require('http').createServer().listen($port,'127.0.0.1')"

# ---- D: nothing listening -------------------------------------------------
Write-Host "`nD. nothing listening on $port"
$d = Clear-ForgeStaleListener -Port $port -CommandLineMustContain @('apps/coordinator/dist/server.js') -Log $log
$results += [pscustomobject]@{ case = 'D nothing listening'; expected = $true; actual = $d }

# ---- A: our own orphan, command line matches ------------------------------
Write-Host "`nA. node listening with a matching command line (the orphan case)"
$a = Start-Process -FilePath 'node' -ArgumentList @('-e', $listenScript, 'apps/coordinator/dist/server.js') -PassThru -WindowStyle Hidden
if (-not (Wait-Listening -Port $port)) { throw 'test A: listener never came up' }
$aResult = Clear-ForgeStaleListener -Port $port -CommandLineMustContain @('apps/coordinator/dist/server.js') -Log $log
$aGone = $a.HasExited -or -not (Get-Process -Id $a.Id -ErrorAction SilentlyContinue)
Stop-Quietly $a
$results += [pscustomobject]@{ case = 'A own orphan cleared'; expected = $true; actual = $aResult }
$results += [pscustomobject]@{ case = 'A orphan process killed'; expected = $true; actual = [bool] $aGone }

# ---- C: node, but a command line we must not kill (the `pnpm dev` guard) ---
Write-Host "`nC. node listening but the command line does NOT match (a dev server)"
$c = Start-Process -FilePath 'node' -ArgumentList @('-e', $listenScript, 'src/server.ts', 'tsx', 'watch') -PassThru -WindowStyle Hidden
if (-not (Wait-Listening -Port $port)) { throw 'test C: listener never came up' }
$cResult = Clear-ForgeStaleListener -Port $port -CommandLineMustContain @('apps/coordinator/dist/server.js') -Log $log
$cAlive = -not $c.HasExited -and [bool] (Get-Process -Id $c.Id -ErrorAction SilentlyContinue)
Stop-Quietly $c
$results += [pscustomobject]@{ case = 'C dev server refused'; expected = $false; actual = $cResult }
$results += [pscustomobject]@{ case = 'C dev server left alive'; expected = $true; actual = $cAlive }

Start-Sleep -Seconds 2

# ---- B: a listener that is not node at all --------------------------------
Write-Host "`nB. a non-node process listening"
$pyCode = "import socket,time`ns=socket.socket()`ns.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)`ns.bind(('127.0.0.1',$port))`ns.listen()`ntime.sleep(120)"
$pyFile = Join-Path $env:TEMP 'forge-listener-test.py'
Set-Content -LiteralPath $pyFile -Value $pyCode -Encoding utf8
$b = Start-Process -FilePath 'python' -ArgumentList @($pyFile) -PassThru -WindowStyle Hidden
if (-not (Wait-Listening -Port $port)) { throw 'test B: listener never came up' }
$bResult = Clear-ForgeStaleListener -Port $port -CommandLineMustContain @('apps/coordinator/dist/server.js') -Log $log
$bAlive = -not $b.HasExited -and [bool] (Get-Process -Id $b.Id -ErrorAction SilentlyContinue)
Stop-Quietly $b
Remove-Item -LiteralPath $pyFile -Force -ErrorAction SilentlyContinue
$results += [pscustomobject]@{ case = 'B non-node refused'; expected = $false; actual = $bResult }
$results += [pscustomobject]@{ case = 'B non-node left alive'; expected = $true; actual = $bAlive }

Start-Sleep -Seconds 2

# ---- E: web, `next start` - the task's own invocation, must clear ----------
Write-Host "`nE. node listening as 'next start' (the web task's orphan)"
$e = Start-Process -FilePath 'node' -ArgumentList @('-e', $listenScript, 'node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1') -PassThru -WindowStyle Hidden
if (-not (Wait-Listening -Port $port)) { throw 'test E: listener never came up' }
$eResult = Clear-ForgeStaleListener -Port $port -CommandLineMustContain @('next/dist/bin/next', ' start ') -Log $log
$eGone = $e.HasExited -or -not (Get-Process -Id $e.Id -ErrorAction SilentlyContinue)
Stop-Quietly $e
$results += [pscustomobject]@{ case = 'E next start cleared'; expected = $true; actual = $eResult }
$results += [pscustomobject]@{ case = 'E next start killed'; expected = $true; actual = [bool] $eGone }

Start-Sleep -Seconds 2

# ---- F: web, `next dev` - a developer's server, must NOT be killed ---------
Write-Host "`nF. node listening as 'next dev' (a developer's pnpm dev)"
$f = Start-Process -FilePath 'node' -ArgumentList @('-e', $listenScript, 'node_modules/next/dist/bin/next', 'dev', '-H', '127.0.0.1') -PassThru -WindowStyle Hidden
if (-not (Wait-Listening -Port $port)) { throw 'test F: listener never came up' }
$fResult = Clear-ForgeStaleListener -Port $port -CommandLineMustContain @('next/dist/bin/next', ' start ') -Log $log
$fAlive = -not $f.HasExited -and [bool] (Get-Process -Id $f.Id -ErrorAction SilentlyContinue)
Stop-Quietly $f
$results += [pscustomobject]@{ case = 'F next dev refused'; expected = $false; actual = $fResult }
$results += [pscustomobject]@{ case = 'F next dev left alive'; expected = $true; actual = $fAlive }

# ---- verdict ---------------------------------------------------------------
Write-Host "`n==== results ===="
$failed = 0
foreach ($r in $results) {
  $ok = ($r.expected -eq $r.actual)
  if (-not $ok) { $failed++ }
  '{0}  {1,-28} expected={2} actual={3}' -f $(if ($ok) { 'PASS' } else { 'FAIL' }), $r.case, $r.expected, $r.actual
}
Write-Host ("`n{0} of {1} passed" -f ($results.Count - $failed), $results.Count)
if ($failed -gt 0) { exit 1 }
