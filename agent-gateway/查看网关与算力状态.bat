@echo off
chcp 65001 >nul
title 查看网关状态与余额
cd /d "%~dp0"
node dist\server.js status
pause
