$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Speech

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$list = @()
try {
  foreach ($v in $synth.GetInstalledVoices()) {
    $i = $v.VoiceInfo
    $list += [pscustomobject]@{
      name    = $i.Name
      culture = $i.Culture.Name
      gender  = [string]$i.Gender
      age     = [string]$i.Age
      enabled = [bool]$v.Enabled
    }
  }
} finally {
  $synth.Dispose()
}
$list | ConvertTo-Json -Compress
