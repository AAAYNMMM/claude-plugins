@echo off
chcp 65001 >nul
title 启动 Claude (自动同步最新模型)

cd /d "%~dp0"
echo ======================================================
echo    agent-gateway - Claude 启动与模型自动同步
echo ======================================================
echo.
echo [1/3] 检查并开启 agent-gateway 守护服务...
call node dist/server.js on

echo.
echo [2/3] 扫描并同步各模块最新可用模型路由...
call node dist/server.js sync

echo.
echo [3/3] 正在拉起 Claude 桌面端...
if exist "%USERPROFILE%\Desktop\claude - 快捷方式.lnk" (
    start "" "%USERPROFILE%\Desktop\claude - 快捷方式.lnk"
) else if exist "C:\Program Files\WindowsApps\Claude_4.23118.1.0_x64__pzs8sxrjxfjjc\app\claude.exe" (
    start "" "C:\Program Files\WindowsApps\Claude_4.23118.1.0_x64__pzs8sxrjxfjjc\app\claude.exe"
) else (
    start claude
)

echo.
echo ✓ Claude 桌面端已拉起，模型已实时更新为最新版本！
timeout /t 2 >nul
