# Fix variable order
$file = "c:/Users/USER/Desktop/AI asistance ppt/111425assignment/game/states/gamestate.js"
$lines = Get-Content $file -Encoding UTF8

# Delete lines 2389-2392 (old order)
$newLines = @()
for ($i = 0; $i -lt 2388; $i++) {
    $newLines += $lines[$i]
}

# Skip lines 2388-2392 (wrong order)
# Add correct order
$newLines += '          const elapsed = dt / 1000;'
$newLines += '          const WAVE_DURATION = 1.5;'
$newLines += '          if (elapsed > WAVE_DURATION) continue;'
$newLines += '          const fade = 1 - (elapsed / WAVE_DURATION);'
$newLines += ''

# Skip old elapsed definition and continue from 2393
for ($i = 2393; $i -lt $lines.Length; $i++) {
    $newLines += $lines[$i]
}

$newLines | Set-Content $file -Encoding UTF8

Write-Host "Variable order fixed!"
