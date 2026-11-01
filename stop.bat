@echo off
chcp 65001 > nul
echo Остановка сервера AirTransfer и туннеля Cloudflare...

taskkill /f /im cloudflared.exe >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :8000') do (
    taskkill /f /pid %%a >nul 2>&1
)

echo.
echo ✅ Сервер и туннель успешно остановлены!
timeout /t 3 > nul
