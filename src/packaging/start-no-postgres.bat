@echo off
setlocal
set "ROOT=%~dp0"
set "APP=%ROOT%app"
set "NODE=%ROOT%node\node.exe"
set "PATH=%ROOT%node;%PATH%"
set "PORT=4317"
set "SECOPS_BIND_HOST=127.0.0.1"
set "SECOPS_WEB_PORT=5317"
set "SECOPS_WEB_HOST=127.0.0.1"
set "SECOPS_API_PORT=4317"
set "SECOPS_API_HOST=127.0.0.1"
set "SECOPS_WORKSPACE_ROOT=%APP%"
set "SECOPS_DURABLE_SESSIONS=off"
set "SECOPS_ALLOWED_HOSTS=localhost,127.0.0.1,::1"
set "SECOPS_ALLOWED_ORIGINS=http://localhost:5317,http://127.0.0.1:5317"

cd /d "%APP%"
echo Starting SecOps Agent system without PostgreSQL durable sessions...
start "SecOps API" /min "%NODE%" "apps\server\dist\index.js"
timeout /t 2 /nobreak >nul
start "SecOps Web" /min "%NODE%" "static-server.mjs"
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:5317"
echo Opened http://127.0.0.1:5317
echo Run stop.bat to stop the services.
pause
