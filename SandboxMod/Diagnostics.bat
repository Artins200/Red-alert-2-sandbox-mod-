@echo off
chcp 65001 >nul 2>&1
title Red Alert 2 Sandbox Mod - diagnostics
cscript //nologo "%~dp0tools\sandbox.js" diag
echo.
pause
