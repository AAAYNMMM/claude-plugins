@echo off
chcp 65001 >nul
cd /d "%~dp0"
title agent-gateway: 开启网关并接入 Claude
echo ======================================================
echo           agent-gateway 网关代理启用程序
echo ======================================================
echo.
echo [1/3] 正在启动网关后台自启守护进程...
node scripts/service.mjs start
if errorlevel 1 (
    echo [错误] 启动网关服务失败！
    pause
    exit /b 1
)

echo.
echo [2/3] 正在扫描全部可用模块模型并同步路由...
node dist/server.js sync

echo.
echo [3/3] 正在将网关合规路由安全接入 Claude 桌面端...
node scripts/app-provider.mjs apply

echo.
echo ======================================================
echo  ✓ 网关已成功开启！
echo  提示：如果您已打开 Claude 桌面端，请【完全重启】Claude 以生效。
echo ======================================================
pause
