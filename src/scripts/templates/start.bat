@echo off
setlocal EnableExtensions EnableDelayedExpansion

rem SecOps Agent launcher. Keep this file ASCII so cmd.exe parses it on every code page.
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

echo ============================================
echo   SecOps Agent v2.0
echo ============================================
echo.
echo Checking Node.js...
where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js v18 or newer is required.
    exit /b 1
)
node -v

rem PGlite creates these directories during init. They are empty and can be
rem dropped by archive/build tools, so restore them before opening a durable DB.
for %%D in ("runtime\pgdata" "runtime\pgdata\pg_commit_ts" "runtime\pgdata\pg_dynshmem" "runtime\pgdata\pg_logical" "runtime\pgdata\pg_logical\mappings" "runtime\pgdata\pg_logical\snapshots" "runtime\pgdata\pg_multixact" "runtime\pgdata\pg_multixact\members" "runtime\pgdata\pg_multixact\offsets" "runtime\pgdata\pg_notify" "runtime\pgdata\pg_replslot" "runtime\pgdata\pg_serial" "runtime\pgdata\pg_snapshots" "runtime\pgdata\pg_stat" "runtime\pgdata\pg_stat_tmp" "runtime\pgdata\pg_subtrans" "runtime\pgdata\pg_tblspc" "runtime\pgdata\pg_twophase" "runtime\pgdata\pg_wal" "runtime\pgdata\pg_wal\archive_status" "runtime\pgdata\pg_wal\summaries" "runtime\pgdata\pg_xact" "runtime\audit" "runtime\approvals" "runtime\sandbox" "runtime\config" "runtime\skills" "runtime\plugins") do (
    if not exist "%%~D\" md "%%~D" >nul 2>&1
)

echo.
echo Checking runtime dependencies...
if not exist "node_modules\ai\package.json" goto install_dependencies
if not exist "node_modules\fastify\package.json" goto install_dependencies
if not exist "node_modules\@electric-sql\pglite\package.json" goto install_dependencies
if not exist "apps\server\dist\index.js" (
    echo [ERROR] Backend build is missing: apps\server\dist\index.js
    exit /b 1
)
if not exist "apps\web\dist\index.html" (
    echo [ERROR] Frontend build is missing: apps\web\dist\index.html
    exit /b 1
)
echo [OK] Runtime dependencies and builds are ready.
goto check_ports

:install_dependencies
echo [INFO] Installing runtime dependencies...
call npm install --omit=dev
if errorlevel 1 (
    echo [ERROR] npm install failed. Check network access and package-lock.json.
    exit /b 1
)
if not exist "node_modules\@electric-sql\pglite\package.json" (
    echo [ERROR] PGlite dependency is still missing after npm install.
    exit /b 1
)
if not exist "apps\server\dist\index.js" (
    echo [ERROR] Backend build is missing: apps\server\dist\index.js
    exit /b 1
)
if not exist "apps\web\dist\index.html" (
    echo [ERROR] Frontend build is missing: apps\web\dist\index.html
    exit /b 1
)

:check_ports
echo Checking ports 4317 and 5317...
set "API_PID="
set "WEB_PID="
for /f "tokens=5" %%P in ('netstat -ano 2^>nul ^| findstr /r /c:":4317 .*LISTENING"') do set "API_PID=%%P"
for /f "tokens=5" %%P in ('netstat -ano 2^>nul ^| findstr /r /c:":5317 .*LISTENING"') do set "WEB_PID=%%P"
if defined API_PID echo [WARN] Port 4317 (API) is in use by PID !API_PID!.
if defined WEB_PID echo [WARN] Port 5317 (Web) is in use by PID !WEB_PID!.
if defined API_PID goto confirm_release_ports
if defined WEB_PID goto confirm_release_ports
goto ports_ready

:confirm_release_ports
choice /C YN /N /M "Release occupied ports and continue? [Y/N] "
if errorlevel 2 (
    echo [INFO] Port release declined. Exiting.
    exit /b 1
)
if defined API_PID (
    echo [INFO] Releasing port 4317, PID !API_PID!...
    taskkill /PID !API_PID! /T /F >nul 2>&1
    if errorlevel 1 (
        echo [ERROR] Could not release PID !API_PID!.
        exit /b 1
    )
)
if defined WEB_PID (
    echo [INFO] Releasing port 5317, PID !WEB_PID!...
    taskkill /PID !WEB_PID! /T /F >nul 2>&1
    if errorlevel 1 (
        echo [ERROR] Could not release PID !WEB_PID!.
        exit /b 1
    )
)
powershell.exe -NoProfile -NonInteractive -Command "Start-Sleep -Milliseconds 500" >nul 2>&1
netstat -ano 2>nul | findstr /r /c:":4317 .*LISTENING" >nul
if not errorlevel 1 (
    echo [ERROR] Port 4317 is still in use. Exiting.
    exit /b 1
)
netstat -ano 2>nul | findstr /r /c:":5317 .*LISTENING" >nul
if not errorlevel 1 (
    echo [ERROR] Port 5317 is still in use. Exiting.
    exit /b 1
)

:ports_ready

if exist "runtime\api.log" del /q "runtime\api.log" >nul 2>&1
if exist "runtime\web.log" del /q "runtime\web.log" >nul 2>&1
if exist "runtime\api.pid" del /q "runtime\api.pid" >nul 2>&1
if exist "runtime\web.pid" del /q "runtime\web.pid" >nul 2>&1

echo Starting backend on http://127.0.0.1:4317...
start "SecOps-API" /min cmd /d /c "node apps\server\dist\index.js > runtime\api.log 2>&1" >nul 2>&1

set "RETRY=0"
:wait_backend
powershell.exe -NoProfile -NonInteractive -Command "Start-Sleep -Seconds 2" >nul 2>&1
curl.exe --fail --silent http://127.0.0.1:4317/api/health >nul 2>&1
if not errorlevel 1 goto backend_ready
set /a RETRY+=1
if !RETRY! LSS 15 goto wait_backend
echo [ERROR] Backend did not become healthy. Last backend log:
if exist "runtime\api.log" type "runtime\api.log"
call :stop_port 4317
exit /b 1

:backend_ready
for /f "tokens=5" %%P in ('netstat -ano 2^>nul ^| findstr /r /c:":4317 .*LISTENING"') do echo %%P>runtime\api.pid
echo [OK] Backend is healthy.
echo Starting frontend on http://127.0.0.1:5317...
start "SecOps-Web" /min cmd /d /c "node static-server.mjs > runtime\web.log 2>&1" >nul 2>&1

set "RETRY=0"
:wait_frontend
powershell.exe -NoProfile -NonInteractive -Command "Start-Sleep -Seconds 1" >nul 2>&1
netstat -ano 2>nul | findstr /r /c:":5317 .*LISTENING" >nul
if not errorlevel 1 goto frontend_ready
set /a RETRY+=1
if !RETRY! LSS 10 goto wait_frontend
echo [ERROR] Frontend did not start. Last frontend log:
if exist "runtime\web.log" type "runtime\web.log"
call :stop_port 5317
call :stop_port 4317
exit /b 1

:frontend_ready
for /f "tokens=5" %%P in ('netstat -ano 2^>nul ^| findstr /r /c:":5317 .*LISTENING"') do echo %%P>runtime\web.pid
echo [OK] Frontend is listening.
echo.
echo SecOps Agent started successfully.
echo   Web:    http://localhost:5317
echo   API:    http://127.0.0.1:4317
echo   Logs:   %APP_DIR%\runtime\api.log and web.log
echo   Stop:   %~dp0stop.bat
echo Opening the web interface in the default browser...
start "" "http://localhost:5317" >nul 2>&1
exit /b 0

:stop_port
for /f "tokens=5" %%P in ('netstat -ano 2^>nul ^| findstr /r /c:":%~1 .*LISTENING"') do (
    if not "%%P"=="0" call :stop_owned %%P %~1
)
exit /b 0

:stop_owned
set "PID_FILE=runtime\web.pid"
if "%~2"=="4317" set "PID_FILE=runtime\api.pid"
set "OWNED_PID="
if exist "%PID_FILE%" set /p OWNED_PID=<"%PID_FILE%"
if "%~1"=="!OWNED_PID!" (
    taskkill /PID %~1 /F >nul 2>&1
    del /q "%PID_FILE%" >nul 2>&1
) else echo [WARN] Skipping PID %~1 (not owned by this runnable app).
exit /b 0
