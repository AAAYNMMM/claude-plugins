@echo off
chcp 65001 >nul
echo 正在卸载 WorkBuddy for Claude Code...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1"
echo.
pause
