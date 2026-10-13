@echo off
setlocal
cd /d "%~dp0"

if not exist keys.local.bat (
  echo keys.local.bat not found.
  echo Copy keys.example.bat to keys.local.bat and put your PumpPortal API key in it.
  pause
  exit /b 1
)
call keys.local.bat

echo === Moto Bug Bot (fast mode) ===
set /p LIVE="Live trading? (y/N): "
if /i "%LIVE%"=="y" (
  set LIVE_TRADING=1
) else (
  set LIVE_TRADING=0
  echo Simulation mode: no trade will be sent.
)

echo.
node script.js
echo.
pause
endlocal
