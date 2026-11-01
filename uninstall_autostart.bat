@echo off
chcp 65001 > nul
set "STARTUP_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "VBS_PATH=%STARTUP_DIR%\AirTransfer_AutoStart.vbs"

if exist "%VBS_PATH%" (
    del "%VBS_PATH%"
    echo ✅ Автозапуск AirTransfer успешно удален из системы!
) else (
    echo Автозапуск уже был отключен.
)
pause
