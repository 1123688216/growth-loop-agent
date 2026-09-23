@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-rag-stack.ps1" %*
if errorlevel 1 (
  echo Stop failed. See the error above.
  pause
  exit /b 1
)
pause
