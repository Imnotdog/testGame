# Fix impact position calculation
$file = "c:/Users/USER/Desktop/AI asistance ppt/111425assignment/game/states/gamestate.js"
$lines = Get-Content $file -Encoding UTF8

# Replace lines 475-476 with correct calculation
$lines[474] = '      const shieldRadius = player.radius * 4;'
$lines[475] = '      const angle = Math.atan2(dirY, dirX);'
$lines[476] = '      const impactX = Math.cos(angle) * shieldRadius * 0.7;'

# Insert new line after 476
$newLines = @()
for ($i = 0; $i -lt 477; $i++) {
    $newLines += $lines[$i]
}
$newLines += '      const impactY = Math.sin(angle) * shieldRadius * 0.7;'
for ($i = 477; $i -lt $lines.Length; $i++) {
    $newLines += $lines[$i]
}

$newLines | Set-Content $file -Encoding UTF8

Write-Host "Impact calculation fixed!"
