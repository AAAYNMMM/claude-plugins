@echo off
chcp 65001 >nul
echo 正在把 WorkBuddy 网关安装到 Claude Code...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
echo.
pause
