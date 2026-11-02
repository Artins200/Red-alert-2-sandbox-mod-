@echo off
rem ==========================================================
rem  Red Alert 2 Sandbox Mod -- official map editor (Final Alert 2)
rem
rem  Puts the mod rules into the game folder, starts
rem  FinalAlert2YR.exe, waits until it is closed and then
rem  returns the original game files.
rem ==========================================================
chcp 65001 >nul 2>&1
setlocal
title Red Alert 2 Sandbox Mod - Final Alert 2
cscript //nologo "%~dp0tools\sandbox.js" fa2
echo.
pause
endlocal
