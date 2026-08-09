@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0fix-smooth-cut-transitions.ps1"
if errorlevel 1 pause
endlocal
