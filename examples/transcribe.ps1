# PowerShell client for the local voice-to-text HTTP API.
#
#   .\examples\transcribe.ps1 -File meeting.wav
#   .\examples\transcribe.ps1 -File meeting.wav -Language en
#   .\examples\transcribe.ps1 -Dictate -Seconds 5
#
# Start the server first:  node .\bin\vtt.mjs serve --port 8791
param(
  [string]$File,
  [ValidateSet('auto', 'zh', 'en', 'yue', 'ja', 'ko')][string]$Language = 'zh',
  [switch]$Dictate,
  [double]$Seconds = 5,
  [string]$Token,
  [int]$Port = 8791
)

$ErrorActionPreference = 'Stop'
$base = "http://127.0.0.1:$Port"
$headers = @{}
if ($Token) { $headers['Authorization'] = "Bearer $Token" }

function Invoke-Vtt {
  param([string]$Path, [byte[]]$Body)
  try {
    if ($Body) {
      return Invoke-RestMethod -Uri "$base$Path" -Method Post -Headers $headers -Body $Body -ContentType 'audio/wav'
    }
    return Invoke-RestMethod -Uri "$base$Path" -Method Post -Headers $headers -Body '{}' -ContentType 'application/json'
  } catch {
    throw "request to $base$Path failed: $($_.Exception.Message)`nIs 'vtt serve' running?"
  }
}

if ($Dictate) {
  Invoke-Vtt -Path '/dictate' | Out-Null
  Write-Host "recording for $Seconds seconds — speak now" -ForegroundColor Cyan
  Start-Sleep -Seconds $Seconds
  $result = Invoke-Vtt -Path '/dictate/stop'
  Write-Host $result.text
  Write-Host ("--- {0:N2}s audio, inference {1:N0}ms" -f $result.audioSeconds, ($result.inferenceSeconds * 1000)) -ForegroundColor DarkGray
  return
}

if (-not $File) { throw 'give -File <wav>, or use -Dictate' }
if (-not (Test-Path $File)) { throw "file not found: $File" }

$bytes = [IO.File]::ReadAllBytes((Resolve-Path $File))
$watch = [Diagnostics.Stopwatch]::StartNew()
$result = Invoke-Vtt -Path "/transcribe?language=$Language" -Body $bytes
$watch.Stop()
Write-Host $result.text
Write-Host ("--- {0:N2}s audio, inference {1:N0}ms, round trip {2:N0}ms" -f $result.seconds, $result.inferenceMs, $watch.Elapsed.TotalMilliseconds) -ForegroundColor DarkGray
