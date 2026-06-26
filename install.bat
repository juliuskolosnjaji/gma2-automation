@echo off
setlocal

REM Installs the automation as a hidden Scheduled Task at user logon.
REM This is preferred over a Windows Service because grandMA2 onPC is a GUI app.

set "APPDIR=%~dp0"
set "TASKNAME=gMA2 onPC Node Automation"
set "VBS=%APPDIR%run-hidden.vbs"
set "NODE_EXE="

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found in PATH. Install Node.js LTS first.
  pause
  exit /b 1
)

for /f "delims=" %%I in ('where node') do if not defined NODE_EXE set "NODE_EXE=%%~fI"
if not defined NODE_EXE (
  echo Node.js path could not be resolved.
  pause
  exit /b 1
)

REM Create hidden runner next to service.js
> "%VBS%" echo Set WshShell = CreateObject("WScript.Shell")
>> "%VBS%" echo WshShell.CurrentDirectory = "%APPDIR%"
>> "%VBS%" echo WshShell.Run Chr(34) ^& "%NODE_EXE%" ^& Chr(34) ^& " " ^& Chr(34) ^& "%APPDIR%service.js" ^& Chr(34), 0, False

schtasks /Create /TN "%TASKNAME%" /SC ONLOGON /TR "wscript.exe ^"%VBS%^"" /RL HIGHEST /F
if errorlevel 1 (
  echo Failed to create scheduled task. Try running this installer as Administrator.
  pause
  exit /b 1
)

schtasks /Run /TN "%TASKNAME%"

echo.
echo Installed and started: %TASKNAME%
echo Service URL: http://127.0.0.1:3737/status
echo.
pause
