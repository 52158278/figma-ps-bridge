@echo off
chcp 65001 >nul
title PS Bridge Service
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 goto nopython

echo ============================================
echo   PS Bridge Service  http://127.0.0.1:8765-8774 (auto)
echo   Keep this window open while working.
echo ============================================
echo.

python server.py
echo.
echo [Stopped] Service exited. Press any key to close.
pause >nul
goto :eof

:nopython
echo [Error] Python not found. Install Python 3 and enable "Add Python to PATH".
echo Download: https://www.python.org/downloads/
pause
