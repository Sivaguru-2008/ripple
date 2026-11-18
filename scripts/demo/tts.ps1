# Speaks each line of a JSON list ([{ "id": "c01", "text": "..." }]) into <outDir>\<id>.wav
# with Windows' built-in speech synthesizer. Offline; nothing is downloaded.
param([string]$List, [string]$OutDir, [string]$Voice = 'Microsoft Zira Desktop', [int]$Rate = 1)
Add-Type -AssemblyName System.Speech
$items = Get-Content -Raw -Encoding UTF8 $List | ConvertFrom-Json
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try { $synth.SelectVoice($Voice) } catch { }
$synth.Rate = $Rate
foreach ($item in $items) {
  $synth.SetOutputToWaveFile((Join-Path $OutDir "$($item.id).wav"))
  $synth.Speak($item.text)
}
$synth.SetOutputToNull()
$synth.Dispose()
