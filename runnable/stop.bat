@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "APP_DIR=%~dp0app"
if not exist "%APP_DIR%\" (
    echo [ERROR] Runnable app directory not found: %APP_DIR%
    exit /b 1
)
cd /d "%APP_DIR%"
if errorlevel 1 (
    echo [ERROR] Cannot change to app directory: %APP_DIR%
    exit /b 1
)

rem Stop the processes that actually own the service ports. This works even
rem when the launcher window title was changed or the console was hidden.
echo Stopping SecOps Agent services...
call :stop_port 4317 API
call :stop_port 5317 Web

powershell.exe -NoProfile -NonInteractive -Command "Start-Sleep -Seconds 1" >nul 2>&1
set "FAILED=0"
for %%P in (4317 5317) do (
    netstat -ano 2>nul | findstr /r /c:":%%P .*LISTENING" >nul
    if not errorlevel 1 (
        echo [WARN] Port %%P is still listening.
        set "FAILED=1"
    )
)
if "%FAILED%"=="0" echo SecOps Agent services stopped.
exit /b %FAILED%

:stop_port
for /f "tokens=5" %%P in ('netstat -ano 2^>nul ^| findstr /r /c:":%~1 .*LISTENING"') do (
    if not "%%P"=="0" (
        call :stop_owned %%P %~1 %~2
    )
)
exit /b 0

:stop_owned
set "PID_FILE=runtime\web.pid"
if "%~2"=="4317" set "PID_FILE=runtime\api.pid"
set "OWNED_PID="
if exist "%PID_FILE%" set /p OWNED_PID=<"%PID_FILE%"
if "%~1"=="!OWNED_PID!" (
    echo Stopping %~3 process %~1...
    taskkill /PID %~1 /F >nul 2>&1
    del /q "%PID_FILE%" >nul 2>&1
) else echo [WARN] Skipping PID %~1 (not owned by this runnable app).
exit /b 0
