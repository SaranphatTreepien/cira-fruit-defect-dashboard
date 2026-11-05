$types = "apple","orange"
for ($i = 1; $i -le 10; $i++) {
  $now = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
  $body = @{
    event_id        = "$now-$('{0:D4}' -f $i)"
    timestamp       = $now
    fruit_type      = $types | Get-Random
    external_result = "good","defect" | Get-Random
    defect_type     = $null
    nir_result      = "not_supported"
    confidence      = [math]::Round((Get-Random -Minimum 70 -Maximum 99) / 100, 2)
    camera_view     = "top"
    model_version   = "mock"
    model_source    = "mock"
  } | ConvertTo-Json
  Invoke-RestMethod -Uri http://localhost:3000/api/ingest -Method Post -ContentType "application/json; charset=utf-8" -Body $body
  Start-Sleep -Milliseconds 500
}
