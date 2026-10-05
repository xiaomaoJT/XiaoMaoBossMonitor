@echo off
REM ===========================================================================
REM  BossMonitor - Windows launcher
REM  Double-click to start the headless detection server.
REM  Requires Node.js 20+ LTS (https://nodejs.org). Keep this window open.
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

for /f "tokens=*" %%v in ('node -p "process.versions.node"') do set NODEVER=%%v
echo [BossMonitor] Node.js %NODEVER%
echo [BossMonitor] Starting server on http://localhost:8787
echo [BossMonitor] Keep this window open. Close it to stop monitoring.
echo.

start "" http://localhost:8787
node server\headless-monitor.mjs

echo.
echo [BossMonitor] Server stopped.
pause
