@echo off
cd /d "%~dp0"
echo Starting ASTRA Boss Bot...
echo.
node index.js 2>&1
echo.
echo Bot stopped. Press any key to exit.
pause >nul
