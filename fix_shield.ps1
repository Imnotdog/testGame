# 讀取檔案
$filePath = "c:/Users/USER/Desktop/AI asistance ppt/111425assignment/game/states/gamestate.js"
$content = Get-Content $filePath -Raw -Encoding UTF8

# 執行替換 - 移除嚴格的波前沿檢查
$pattern = '// Only show hexes near the wave front\r\n\s+if \(distFromImpact >= waveRadius - WAVE_THICKNESS &&\s*\r\n\s+distFromImpact <= waveRadius \+ WAVE_THICKNESS / 2\) \{\r\n\s+shouldDisplay = true;'
$replacement = 'shouldDisplay = true; // 簡化：顯示所有被擊中扇區'

$newContent = $content -replace $pattern, $replacement

# 儲存檔案
Set-Content $filePath $newContent -Encoding UTF8 -NoNewline

Write-Host "✓ 檔案已成功修改！"
Write-Host "修改位置：第 2401-2404 行"
Write-Host "請重新整理瀏覽器查看護盾效果"
