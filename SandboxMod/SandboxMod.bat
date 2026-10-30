@echo off
rem ==========================================================
rem  Red Alert 2 Sandbox Mod -- launcher
rem
rem  Drop the SandboxMod folder into the game folder and use it
rem  as the Steam launch option:
rem     "C:\...\Command & Conquer Red Alert II\SandboxMod\SandboxMod.bat" %command%
rem  Started without arguments it opens the settings menu.
rem ==========================================================
chcp 65001 >nul 2>&1
setlocal
title Red Alert 2 Sandbox Mod
set "SANDBOX_CMD=%*"
if "%~1"=="" goto menu
cscript //nologo "%~dp0tools\sandbox.js" run
goto done
:menu
cscript //nologo "%~dp0tools\sandbox.js"
:done
if errorlevel 2 pause
endlocal
