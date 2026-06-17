import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dryRun = process.argv.includes("--dry-run");

if (process.platform !== "win32") {
  console.log("stop:dev is currently implemented for Windows dev hosts.");
  console.log(`Project root: ${projectRoot}`);
  console.log("Stop foreground dev servers with Ctrl+C, or terminate the npm/vite/tsx processes for this project.");
  process.exit(0);
}

const psScript = `
$ErrorActionPreference = "Stop"
$root = $env:SECOPS_STOP_DEV_PROJECT_ROOT
$allowedNames = @("cmd.exe", "node.exe", "esbuild.exe")
$processes = Get-CimInstance Win32_Process | Where-Object {
  $_.CommandLine -and
  $allowedNames -contains $_.Name -and
  $_.CommandLine.Contains($root) -and
  (
    $_.CommandLine -like "*npm run dev*" -or
    $_.CommandLine -like "*concurrently*" -or
    $_.CommandLine -like "*tsx*" -or
    $_.CommandLine -like "*vite*" -or
    $_.CommandLine -like "*esbuild*"
  )
} | Select-Object ProcessId, ParentProcessId, Name, CommandLine

if (-not $processes) {
  "[]"
} else {
  $processes | ConvertTo-Json -Depth 4
}
`;

let processes;
try {
  const raw = execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psScript], {
    encoding: "utf8",
    env: {
      ...process.env,
      SECOPS_STOP_DEV_PROJECT_ROOT: projectRoot
    }
  }).trim();
  const parsed = raw ? JSON.parse(raw) : [];
  processes = Array.isArray(parsed) ? parsed : [parsed];
} catch (error) {
  console.error("Failed to inspect dev processes.");
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

if (processes.length === 0) {
  console.log("No matching dev server processes found.");
  process.exit(0);
}

const selected = new Set(processes.map((processInfo) => Number(processInfo.ProcessId)));
const roots = processes.filter((processInfo) => !selected.has(Number(processInfo.ParentProcessId)));

console.log(`${dryRun ? "Would stop" : "Stopping"} ${roots.length} dev process tree(s) for ${projectRoot}:`);
for (const processInfo of roots) {
  console.log(`- PID ${processInfo.ProcessId} ${processInfo.Name}`);
}

if (dryRun) {
  process.exit(0);
}

let failed = false;
for (const processInfo of roots) {
  try {
    if (!isProcessRunning(processInfo.ProcessId)) {
      continue;
    }
    const output = execFileSync("taskkill.exe", ["/PID", String(processInfo.ProcessId), "/T", "/F"], {
      encoding: "utf8"
    });
    process.stdout.write(output);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stdout = typeof error === "object" && error && "stdout" in error ? String(error.stdout) : "";
    const stderr = typeof error === "object" && error && "stderr" in error ? String(error.stderr) : "";
    const combined = `${message}\n${stdout}\n${stderr}`;
    if (combined.includes("not found")) {
      continue;
    }
    process.stderr.write(combined);
    failed = true;
  }
}

process.exit(failed ? 1 : 0);

function isProcessRunning(pid) {
  try {
    const output = execFileSync("tasklist.exe", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
      encoding: "utf8"
    });
    return output.includes(`"${pid}"`);
  } catch {
    return false;
  }
}
