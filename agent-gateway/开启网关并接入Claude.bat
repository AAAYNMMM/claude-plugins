@echo off
chcp 65001 >nul
title 开启 agent-gateway
cd /d "%~dp0"
node dist\server.js on
pause
