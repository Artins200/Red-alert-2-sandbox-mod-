@echo off
rem ==========================================================
rem  Red Alert 2 Sandbox Mod -- settings window
rem
rem  Opens the window with all the checkboxes (no console).
rem  Started from Steam? Then use SandboxMod.bat: it needs
rem  the %command% line that Steam passes in.
rem ==========================================================
chcp 65001 >nul 2>&1
setlocal
title Red Alert 2 Sandbox Mod - settings
if not exist "%~dp0tools\settings.hta" goto console
start "" mshta "%~dp0tools\settings.hta"
goto done
:console
cscript //nologo "%~dp0tools\sandbox.js"
:done
endlocal
