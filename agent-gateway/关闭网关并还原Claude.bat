@echo off
chcp 65001 >nul
title 关闭 agent-gateway
cd /d "%~dp0"
node dist\server.js off
pause
