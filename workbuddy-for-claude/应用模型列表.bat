@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在把 DeepSeek / WorkBuddy 模型列表写入桌面 App 的 provider 配置...
node scripts\app-provider.mjs apply
echo.
echo 请重启 Claude App 使其生效。
pause
