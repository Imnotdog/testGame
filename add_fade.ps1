# Add missing fade and WAVE_DURATION calculation
$file = "c:/Users/USER/Desktop/AI asistance ppt/111425assignment/game/states/gamestate.js"
$lines = Get-Content $file -Encoding UTF8

# Insert after line 2388 (index 2387)
$newLines = @()
for ($i = 0; $i -lt 2388; $i++) {
    $newLines += $lines[$i]
}

# Add missing calculation lines
$newLines += '          const WAVE_DURATION = 1.5;'
$newLines += '          if (elapsed > WAVE_DURATION) continue;'
$newLines += '          const fade = 1 - (elapsed / WAVE_DURATION);'
$newLines += ''

# Continue with rest
for ($i = 2388; $i -lt $lines.Length; $i++) {
    $newLines += $lines[$i]
}

$newLines | Set-Content $file -Encoding UTF8

Write-Host "Missing fade variable added!"
