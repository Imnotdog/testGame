@echo off
cd /d %~dp0
chcp 65001 >nul
where ngrok >nul 2>nul
if errorlevel 1 (
  echo [!] 找不到 ngrok.exe，請下載 https://ngrok.com/download 放這個資料夾
  pause
  exit /b
)
echo [*] 啟動 ngrok 隧道 (HTTPS/WSS)...
ngrok http 8080
