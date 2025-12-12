# 添加波紋擴散效果
$filePath = "c:/Users/USER/Desktop/AI asistance ppt/111425assignment/game/states/gamestate.js"
$content = Get-Content $filePath -Raw -Encoding UTF8

# 舊代碼模式
$oldPattern = @'
          shouldDisplay = true; // 簡化：顯示所有被擊中扇區

          // Calculate brightness based on distance
          let brightness = Math\.max\(0, 1 - distFromImpact / R_OUT\) \* 0\.5 \+ 0\.3;
          brightness = Math\.min\(1, brightness\);

          // Edge brightening - brighter when near shield edge
          const distToEdge = R_OUT - d;
          if \(distToEdge < 15\) \{
            const edgeFactor = 1 \+ \(1 - distToEdge / 15\) \* 0\.8;
            brightness \*= edgeFactor;
          \}

          // Apply fade
          brightness \*= fade;
          totalBrightness \+= brightness;
'@

# 新代碼
$newCode = @'
          // 波紋擴散效果
          const WAVE_SPEED = 200; // 擴散速度（像素/秒）
          const waveRadius = elapsed * WAVE_SPEED;
          const WAVE_THICKNESS = 50; // 波前沿厚度
          
          // 只顯示波前沿附近的六邊形
          if (distFromImpact < waveRadius - WAVE_THICKNESS) continue; // 波已過
          if (distFromImpact > waveRadius + WAVE_THICKNESS) continue; // 波未到
          
          shouldDisplay = true;

          // Calculate brightness - 在波中心最亮
          const distToWaveFront = Math.abs(distFromImpact - waveRadius);
          let brightness = 1 - (distToWaveFront / WAVE_THICKNESS);
          brightness = Math.max(0, Math.min(1, brightness)) * 0.7 + 0.2; // 20-90% 亮度

          // Edge brightening - 到達邊緣時更亮
          const distToEdge = R_OUT - d;
          if (distToEdge < 15) {
            brightness *= 1 + (1 - distToEdge / 15) * 0.5;
          }

          // Apply fade
          brightness *= fade;
          totalBrightness += brightness;
'@

$newContent = $content -replace $oldPattern, $newCode

Set-Content $filePath $newContent -Encoding UTF8 -NoNewline

Write-Host "✓ 波紋擴散效果已添加！"
Write-Host "效果：從擊中點向外擴散，像水波紋一樣"
