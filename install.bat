@echo off
title MediaZip – Installer
color 0B
echo.
echo  ============================================
echo    MediaZip – Dependency Installer
echo  ============================================
echo.

echo  [1/3] Checking Python / pip...
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo  ERROR: Python not found!
    echo  Please install Python from https://www.python.org/downloads/
    echo  Make sure to check "Add Python to PATH" during installation.
    pause
    exit /b 1
)
echo  OK - Python found.
echo.

echo  [2/3] Installing / Updating yt-dlp...
pip install -U yt-dlp
if %errorlevel% neq 0 (
    echo  ERROR: Failed to install yt-dlp!
    pause
    exit /b 1
)
echo  OK - yt-dlp installed.
echo.

echo  [3/3] Installing Node.js packages (Express)...
npm install
if %errorlevel% neq 0 (
    echo  ERROR: npm install failed!
    echo  Please install Node.js from https://nodejs.org/
    pause
    exit /b 1
)
echo  OK - Node packages installed.
echo.

echo  ============================================
echo    Installation complete!
echo    Run start.bat to launch MediaZip.
echo  ============================================
echo.

echo  NOTE: For HD (1080p+) YouTube downloads, ffmpeg is required.
echo  Download ffmpeg: https://www.gyan.dev/ffmpeg/builds/
echo  Extract and add to PATH for best quality support.
echo.

pause
