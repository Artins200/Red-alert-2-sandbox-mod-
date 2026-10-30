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
rem Double-clicked: open the window with the checkboxes.
rem Start with the argument "menu" to get the old console menu,
rem and "console" as well.
if /i "%~1"=="menu" goto console
if /i "%~1"=="console" goto console
if not exist "%~dp0tools\settings.hta" goto console
start "" mshta "%~dp0tools\settings.hta"
goto done
:console
cscript //nologo "%~dp0tools\sandbox.js"
:done
if errorlevel 2 pause
endlocal
