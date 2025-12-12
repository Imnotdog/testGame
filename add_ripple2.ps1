# Add ripple wave effect
$filePath = "c:/Users/USER/Desktop/AI asistance ppt/111425assignment/game/states/gamestate.js"
$lines = Get-Content $filePath -Encoding UTF8

# Find and replace lines 2401-2416 with new ripple logic
$startLine = 2400  # 0-indexed
$endLine = 2415

# New code lines
$newLines = @(
    '          // Ripple wave effect',
    '          const WAVE_SPEED = 200;',
    '          const waveRadius = elapsed * WAVE_SPEED;',
    '          const WAVE_THICKNESS = 50;',
    '          ',
    '          if (distFromImpact < waveRadius - WAVE_THICKNESS) continue;',
    '          if (distFromImpact > waveRadius + WAVE_THICKNESS) continue;',
    '          ',
    '          shouldDisplay = true;',
    '',
    '          const distToWaveFront = Math.abs(distFromImpact - waveRadius);',
    '          let brightness = 1 - (distToWaveFront / WAVE_THICKNESS);',
    '          brightness = Math.max(0, Math.min(1, brightness)) * 0.7 + 0.2;',
    '',
    '          const distToEdge = R_OUT - d;',
    '          if (distToEdge < 15) {',
    '            brightness *= 1 + (1 - distToEdge / 15) * 0.5;',
    '          }',
    '',
    '          brightness *= fade;',
    '          totalBrightness += brightness;'
)

# Replace lines
$result = @()
for ($i = 0; $i -lt $lines.Length; $i++) {
    if ($i -ge $startLine -and $i -le $endLine) {
        if ($i -eq $startLine) {
            $result += $newLines
        }
        continue
    }
    $result += $lines[$i]
}

$result | Set-Content $filePath -Encoding UTF8

Write-Host "Ripple effect added!"
