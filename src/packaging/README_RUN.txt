SecOps Agent executable package

Start:
1. Double-click start.bat.
2. Browser opens http://127.0.0.1:5317.
3. Double-click stop.bat to stop the API and web server.

Ports:
- API: 127.0.0.1:4317
- Web: 127.0.0.1:5317

The main app registers 38 tools, including 19 Wazuh tools and 12 Shuffle tools.
Runtime configuration is read from app\.env. Replace sensitive values before sharing the package.
start.bat runs with embedded durable sessions (built-in PGlite, data under app\runtime\pgdata). No Docker or external database is needed.
start-no-postgres.bat disables durable sessions (SECOPS_DURABLE_SESSIONS=off) for a temporary, in-memory run.
