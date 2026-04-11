@echo off
cd /d "%~dp0"
echo Mobile-first project start in ontwikkelstand...
echo Laat dit venster open tijdens het testen.
node --watch server.js
pause
