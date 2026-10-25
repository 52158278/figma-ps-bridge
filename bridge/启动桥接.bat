@echo off
chcp 65001 >nul
title PS Bridge Service
cd /d "%~dp0"

rem Prefer "python"; fall back to the "py" launcher (python is often not on PATH).
set "PY_CMD="

where python >nul 2>nul
if not errorlevel 1 (
  python --version >nul 2>nul
  if not errorlevel 1 set "PY_CMD=python"
)

if not defined PY_CMD (
  where py >nul 2>nul
  if not errorlevel 1 (
    py -3 --version >nul 2>nul
    if not errorlevel 1 set "PY_CMD=py -3"
  )
)

if not defined PY_CMD (
  where py >nul 2>nul
  if not errorlevel 1 (
    py --version >nul 2>nul
    if not errorlevel 1 set "PY_CMD=py"
  )
)

if not defined PY_CMD goto nopython

echo ============================================
echo   PS Bridge Service  http://127.0.0.1:8765-8774 (auto)
echo   Keep this window open while working.
echo ============================================
echo   Python launcher: %PY_CMD%
echo.

%PY_CMD% server.py
echo.
echo [Stopped] Service exited. Press any key to close.
pause >nul
goto :eof

:nopython
echo [Error] Python 3 not found. Tried: python, py -3, py.
echo Download: https://www.python.org/downloads/
echo Install Python 3 and tick "Add Python to PATH", then run this file again.
pause
