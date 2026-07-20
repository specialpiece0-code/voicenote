@echo off
rem VoiceNote local server launcher
rem Starts server.ps1 (opens browser automatically at the bound port)
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1" -Port 8788 -OpenBrowser
