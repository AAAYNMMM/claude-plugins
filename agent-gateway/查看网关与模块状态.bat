@echo off
chcp 65001 >nul
cd /d "%~dp0"
title agent-gateway: 网关与模块运行状态
echo ======================================================
echo           agent-gateway 网关与模块运行状态
echo ======================================================
echo.
echo [1] 桌面端配置状态：
node scripts/app-provider.mjs show
echo.
echo [2] 各子模块状态（反重力/WorkBuddy余额）：
node dist/server.js status
echo.
echo ======================================================
pause
