# Remove duplicate wave code
$file = "c:/Users/USER/Desktop/AI asistance ppt/111425assignment/game/states/gamestate.js"
$lines = Get-Content $file -Encoding UTF8

# Remove lines 2389-2396 (0-indexed: 2388-2395)
$newLines = @()
for ($i = 0; $i -lt $lines.Length; $i++) {
    if ($i -ge 2388 -and $i -le 2395) {
        continue
    }
    $newLines += $lines[$i]
}

$newLines | Set-Content $file -Encoding UTF8

Write Host "Duplicate code removed!"
