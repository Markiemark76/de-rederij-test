@echo off
cd /d "%~dp0"
echo Website start in automatische ontwikkelstand...
echo Laat dit venster open tijdens het testen.
echo Bij wijzigingen in server.js start de site vanzelf opnieuw.
node --watch server.js
pause
