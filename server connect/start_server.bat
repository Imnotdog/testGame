@echo off
cd /d %~dp0
chcp 65001 >nul
echo [*] 現在位置：%cd%

where node >nul 2>nul
if errorlevel 1 (
  echo [!] 未安裝 Node.js，請至 https://nodejs.org/
  pause
  exit /b
)

if not exist "node_modules\ws" (
  echo [+] 尚未安裝 ws 模組，正在安裝...
  call npm install ws
)

echo [*] 啟動 signaling server...
node server.js

echo [!] 若未出現 "listening on ws://0.0.0.0:8080" 表示伺服器未成功。
pause
