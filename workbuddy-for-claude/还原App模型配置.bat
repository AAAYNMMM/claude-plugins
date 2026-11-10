@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在把桌面 App 的 provider 配置还原到安装前...
node scripts\app-provider.mjs restore
echo.
echo 请重启 Claude App 使其生效。
pause
