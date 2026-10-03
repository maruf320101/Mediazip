@echo off
title MediaZip Server
color 0B
echo.
echo  ╔══════════════════════════════════════════╗
echo  ║   ⚡  Starting MediaZip Server...         ║
echo  ╚══════════════════════════════════════════╝
echo.

:: Check Node.js
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo  ERROR: Node.js not found!
    echo  Install from: https://nodejs.org/
    pause
    exit /b 1
)

:: Check if node_modules exists
if not exist "node_modules" (
    echo  First run: Installing dependencies...
    npm install
    echo.
)

:: Update yt-dlp before starting (optional, can be slow)
:: pip install -U yt-dlp >nul 2>&1

echo  Server starting at http://localhost:3000
echo  Press Ctrl+C to stop.
echo.

:: Open browser after a short delay
start /b timeout /t 2 /nobreak >nul && start "" "http://localhost:3000"

:: Start the Node.js server
node server.js
