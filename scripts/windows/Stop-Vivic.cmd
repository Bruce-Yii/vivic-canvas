@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Stop-Vivic.ps1"
if errorlevel 1 pause
