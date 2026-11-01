@echo off
chcp 65001 > nul
set "TARGET_DIR=%~dp0"
set "STARTUP_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"

echo ========================================================
echo   Настройка фонового автозапуска AirTransfer
echo ========================================================
echo.

set "VBS_PATH=%STARTUP_DIR%\AirTransfer_AutoStart.vbs"
(
echo Set WshShell = CreateObject^("WScript.Shell"^)
echo WshShell.CurrentDirectory = "%TARGET_DIR:~0,-1%"
echo WshShell.Run "python server.py", 0, False
) > "%VBS_PATH%"

echo ✅ Автозапуск успешно включен!
echo.
echo Теперь при каждом включении компьютера:
echo  1. Сервер и интернет-ссылка запускаются САМИ в фоне.
echo  2. Никаких черных консолей и батников на экране не будет.
echo  3. Вы просто открываете сайт из закладок на ПК или айфоне.
echo.
echo Чтобы отключить автозапуск, запустите: uninstall_autostart.bat
echo ========================================================
pause
