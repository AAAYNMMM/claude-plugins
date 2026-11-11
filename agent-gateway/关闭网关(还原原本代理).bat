@echo off
chcp 65001 >nul
cd /d "%~dp0"
title agent-gateway: 关闭网关并还原原本代理
echo ======================================================
echo           agent-gateway 网关代理关闭与还原程序
echo ======================================================
echo.
echo [1/2] 正在关闭 Claude 桌面端的网关映射，并完整还原您原本的代理/账号...
node scripts/app-provider.mjs restore

echo.
echo [2/2] 正在停止后台网关服务...
node scripts/service.mjs stop

echo.
echo ======================================================
echo  ✓ 网关已成功关闭，已 100% 还原为开启网关前的原本配置！
echo  提示：请【重启】Claude 桌面端生效。
echo ======================================================
pause
