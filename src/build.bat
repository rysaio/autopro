@echo off
REM Rebuild the runnable executable\ bundle from this source tree.
REM Requires Node.js + npm installed on this (developer) machine.
setlocal
cd /d "%~dp0"
echo Rebuilding executable package from source...
call node scripts\pack.mjs
if errorlevel 1 (
  echo.
  echo Pack FAILED. See the messages above.
) else (
  echo.
  echo Pack succeeded. The runnable package is in ..\executable\
)
pause
