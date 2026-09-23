@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-rag-stack.ps1" %*
if errorlevel 1 (
  echo Startup failed. See the error and log path above.
  pause
  exit /b 1
)
pause
