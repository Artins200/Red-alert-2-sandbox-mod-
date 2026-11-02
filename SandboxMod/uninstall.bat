@echo off
chcp 65001 >nul 2>&1
title Red Alert 2 Sandbox Mod - uninstall
cscript //nologo "%~dp0tools\sandbox.js" uninstall
echo.
pause
