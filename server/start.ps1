# Starts the Laya server hidden, logging to server/laya_server.log. Safe to re-run: reuses a live server.
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $here "laya_server.log"
try { Invoke-RestMethod http://127.0.0.1:8756/ -TimeoutSec 2 | Out-Null; Write-Host "laya server already running"; exit 0 } catch {}
Start-Process python -ArgumentList "`"$(Join-Path $here 'laya_server.py')`"" -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError (Join-Path $here "laya_server.err.log")
for ($i = 0; $i -lt 120; $i++) {
  Start-Sleep 1
  try { Invoke-RestMethod http://127.0.0.1:8756/ -TimeoutSec 2 | Out-Null; Write-Host "laya server up (log: $log)"; exit 0 } catch {}
}
Write-Host "laya server did not come up; see $log"; exit 1
