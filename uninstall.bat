@echo off
setlocal
set "TASKNAME=gMA2 onPC Node Automation"
schtasks /End /TN "%TASKNAME%" >nul 2>nul
schtasks /Delete /TN "%TASKNAME%" /F
if exist "%~dp0run-hidden.vbs" del "%~dp0run-hidden.vbs"
echo Uninstalled: %TASKNAME%
pause
