## 護盾波紋效果問題排查

### 問題現狀：
- "Shield hit registered" ✓ 正常
- "Drew 0 hexagons" ✗ 沒有六邊形被繪製

### 根本原因：
波前沿檢查條件太嚴格：
```javascript
if (distFromImpact >= waveRadius - WAVE_THICKNESS && 
    distFromImpact <= waveRadius + WAVE_THICKNESS / 2)
```

這導致幾乎沒有六邊形符合條件。

### 建議方案：
1. **簡化邏輯**：先移除波紋效果，改為顯示整個被擊中扇區
2. **確認顯示正常後**，再逐步添加波紋動畫

### 需要修改的程式碼位置：
`gamestate.js` 第 2401-2404 行

將嚴格的距離檢查：
```javascript
if (distFromImpact >= waveRadius - WAVE_THICKNESS && 
    distFromImpact <= waveRadius + WAVE_THICKNESS / 2) {
```

改為簡單顯示：
```javascript
if (true) { // 先顯示所有被擊中扇區的六邊形
```
