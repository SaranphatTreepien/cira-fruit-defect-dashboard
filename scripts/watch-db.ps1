param(
    [int]$IntervalSeconds = 1,
    [int]$Limit = 10
)

$ErrorActionPreference = "Stop"

Set-Location (Split-Path -Parent $PSScriptRoot)

$query = @"
SELECT
  event_id,
  ts,
  fruit_type,
  external_result,
  confidence,
  model_source,
  created_at
FROM fruit_events
ORDER BY created_at DESC, ts DESC
LIMIT $Limit;
"@

Write-Host "Watching latest fruit_events every $IntervalSeconds second(s). Press Ctrl+C to stop."

$lastEventKey = $null
while ($true) {
    $rows = docker exec cira-db psql -U cira -d cira_core -At -F "|" -c $query 2>&1

    if ($LASTEXITCODE -ne 0) {
        Write-Host ""
        Write-Host ("[{0}] Database read failed; check that cira-db is running." -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss")) -ForegroundColor Red
        Start-Sleep -Seconds $IntervalSeconds
        continue
    }

    $latestRow = @($rows | Where-Object { $_ -and $_ -notmatch "^NOTICE:" }) | Select-Object -First 1
    if ($latestRow -and $latestRow -ne $lastEventKey) {
        Write-Host ""
        Write-Host ("[{0}] Latest data or new event:" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss")) -ForegroundColor Cyan
        docker exec cira-db psql -U cira -d cira_core -c $query
        $lastEventKey = $latestRow
    }

    Start-Sleep -Seconds $IntervalSeconds
}
