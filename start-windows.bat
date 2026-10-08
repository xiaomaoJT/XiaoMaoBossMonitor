@echo off
REM ===========================================================================
REM  BossMonitor - Windows launcher
REM  Double-click to start the headless detection server.
REM  Requires Node.js 20+ LTS (https://nodejs.org).
REM
REM  NOTE: keep this file ASCII-only. cmd.exe reads .bat in the OEM code page,
REM  so UTF-8 Chinese text here would show up as garbage on a GBK console.
REM ===========================================================================
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [BossMonitor] Node.js was not found in PATH.
  echo [BossMonitor] Install Node.js 20+ LTS from https://nodejs.org then run this file again.
  echo.
  pause
  exit /b 1
)

REM --- Already running? Do not start a second copy. -------------------------
REM Two instances fight over the same port: the late one keeps retrying with
REM EADDRINUSE and just sits there as an extra window that does nothing.
netstat -ano | findstr /c:":8787" | findstr /c:"LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo [BossMonitor] Port 8787 is already listening - the server is running.
  echo [BossMonitor] Not starting a second copy. Opening the UI instead.
  start "" http://localhost:8787
  echo.
  echo [BossMonitor] To restart the server use "Restart now" in the UI,
  echo [BossMonitor] or send /reboot confirm to the Telegram bot.
  timeout /t 8 >nul
  exit /b 0
)

for /f "tokens=*" %%v in ('node -p "process.versions.node"') do set NODEVER=%%v
echo [BossMonitor] Node.js %NODEVER%
echo [BossMonitor] Starting server on http://localhost:8787
echo.
echo [BossMonitor] Notes:
echo    - This window is the server console; logs are printed here.
echo    - After a self-heal restart the new process takes over and this
echo      window exits by itself (see server\data\restart.log).
echo    - If it keeps restarting, there are backlogged Telegram commands.
echo      Clear them once with:
echo        node server\headless-monitor.mjs --drop-pending
echo.

start "" http://localhost:8787
node server\headless-monitor.mjs
set EXITCODE=%errorlevel%

echo.
if "%EXITCODE%"=="0" (
  echo [BossMonitor] Server stopped, or a self-heal restart took over.
  echo [BossMonitor] Details: server\data\restart.log
  echo [BossMonitor] Closing this window in 6 seconds.
  timeout /t 6 >nul
  exit /b 0
)

echo [BossMonitor] Server exited with code %EXITCODE%. To debug, check:
echo     server\data\restart.log
echo     server\data\restart.json
echo.
pause
