param(
  [Parameter(Mandatory=$true)][string]$TextFile,
  [Parameter(Mandatory=$true)][string]$OutFile,
  [string]$Voice = "",
  [int]$Rate = 0,
  [int]$Volume = 100
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Speech

$text = [IO.File]::ReadAllText($TextFile, [Text.Encoding]::UTF8)
if ([string]::IsNullOrWhiteSpace($text)) { throw "empty text" }

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  if ($Voice -and $Voice.Trim().Length -gt 0) {
    try { $synth.SelectVoice($Voice) } catch { }
  }
  $synth.Rate = [Math]::Max(-10, [Math]::Min(10, $Rate))
  $synth.Volume = [Math]::Max(0, [Math]::Min(100, $Volume))

  $dir = Split-Path -Parent $OutFile
  if ($dir -and -not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
  }
  if (Test-Path -LiteralPath $OutFile) { Remove-Item -LiteralPath $OutFile -Force }

  $synth.SetOutputToWaveFile($OutFile)
  $synth.Speak($text)
} finally {
  $synth.Dispose()
}

if (-not (Test-Path -LiteralPath $OutFile)) { throw "synthesis produced no file" }
Write-Output "OK"
