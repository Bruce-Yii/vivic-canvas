@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-Vivic.ps1"
if errorlevel 1 pause
