# 修復 gamestate.js 的語法錯誤
$filePath = "c:/Users/USER/Desktop/AI asistance ppt/111425assignment/game/states/gamestate.js"

# 讀取所有行
$lines = Get-Content $filePath -Encoding UTF8

# 修復第 2403-2417 行的縮排（索引從 0 開始，所以是 2402-2416）
# 移除多餘的縮排（從 12 個空格改為 10 個）
for ($i = 2402; $i -le 2415; $i++) {
    if ($lines[$i] -match '^\s{12}') {
        $lines[$i] = $lines[$i] -replace '^\s{12}', '          '
    }
}

# 移除第 2417 行（索引 2416）的多餘右大括號
$lines[2416] = $lines[2416] -replace '^\s+\}$', '        }'

# 儲存
$lines | Set-Content $filePath -Encoding UTF8

Write-Host "語法錯誤已修復！"
