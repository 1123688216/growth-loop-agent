@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\ragflow-stack.ps1" %*
set "ragflow_exit=%ERRORLEVEL%"
pause
exit /b %ragflow_exit%
