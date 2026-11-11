@echo off
chcp 65001 >nul
title 同步最新模型
cd /d "%~dp0"
node dist\server.js sync
node dist\server.js on
pause
