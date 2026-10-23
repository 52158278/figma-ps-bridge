@echo off
chcp 65001 >nul
title Figma-PS Bridge Setup
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy.ps1" %*
echo.
pause