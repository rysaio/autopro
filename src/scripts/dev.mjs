import { copyFileSync, cpSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apiUrl = process.env.SECOPS_DEV_API_URL?.trim() || "http://127.0.0.1:4317/api/health";
const timeoutMs = parsePositiveInteger(process.env.SECOPS_DEV_STARTUP_TIMEOUT_MS, 30_000);
const children = new Set();
let shuttingDown = false;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    shutdown(0);
  });
}

try {
  ensureModelConfig();
  prepareRuntimeCapabilities();
  const server = startNpmScript("dev:server");
  console.log(`[dev] waiting for backend: ${apiUrl}`);
  await waitForApi(server);
  console.log("[dev] backend is ready; starting Vite");
  const web = startNpmScript("dev:web");

  const result = await Promise.race([
    waitForExit("server", server),
    waitForExit("web", web)
  ]);
  if (!shuttingDown) {
    console.error(`[dev] ${result.name} exited with code ${result.code ?? "unknown"}`);
    shutdown(result.code || 1);
  }
} catch (error) {
  console.error(`[dev] ${error instanceof Error ? error.message : String(error)}`);
  shutdown(1);
}

function startNpmScript(script) {
  const child = process.platform === "win32"
    ? spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `npm run ${script}`], {
        cwd: root,
        stdio: "inherit"
      })
    : spawn("npm", ["run", script], {
        cwd: root,
        stdio: "inherit",
        // 让 npm 成为新进程组组长，停止时可通过 kill(-pid) 把
        // npm -> sh -> tsx watch/vite 这一整棵进程树一起停掉，避免 WSL
        // 下残留 watcher 继续占用 4317/5317。
        detached: true
      });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

function ensureModelConfig() {
  const configPath = path.join(root, "runtime", "config", "model.json");
  const templatePath = path.join(root, "scripts", "templates", "model.json");
  if (existsSync(configPath) || !existsSync(templatePath)) {
    return;
  }
  mkdirSync(path.dirname(configPath), { recursive: true });
  copyFileSync(templatePath, configPath);
  console.log(`[dev] created default model config: ${configPath}`);
}

function prepareRuntimeCapabilities() {
  const runtimeRoot = path.join(root, "runtime");
  const pluginsRoot = path.join(runtimeRoot, "plugins");
  mkdirSync(path.join(runtimeRoot, "skills"), { recursive: true });
  mkdirSync(pluginsRoot, { recursive: true });
  const plugins = [
    { workspace: "@secops-agent/wazuh-secops", directory: "wazuh-secops", items: ["dist", "package.json", ".mcp.json", ".codex-plugin", "skills", "README.md"] },
    { workspace: "@secops-agent/shuffle-secops", directory: "shuffle-secops", items: ["dist", "package.json", ".mcp.json", ".codex-plugin", "skills", "README.md"] },
    { workspace: "@secops-agent/shell-secops", directory: "shell-secops", items: ["server.mjs", "package.json", ".mcp.json", ".codex-plugin", "README.md"] },
    { workspace: "@secops-agent/network-secops", directory: "network-secops", items: ["server.mjs", "package.json", ".mcp.json", ".codex-plugin", "README.md"] }
  ];
  for (const plugin of plugins) {
    if (process.platform === "win32") {
      execFileSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `npm run build -w ${plugin.workspace}`], {
        cwd: root,
        stdio: "inherit"
      });
    } else {
      execFileSync("npm", ["run", "build", "-w", plugin.workspace], {
        cwd: root,
        stdio: "inherit"
      });
    }
    const sourceDir = path.join(root, "plugins", plugin.directory);
    const targetDir = path.join(pluginsRoot, plugin.directory);
    mkdirSync(targetDir, { recursive: true });
    for (const item of plugin.items) {
      const sourceItem = path.join(sourceDir, item);
      if (existsSync(sourceItem)) {
        cpSync(sourceItem, path.join(targetDir, item), { recursive: true, force: true });
      }
    }
    console.log(`[dev] prepared runtime plugin: ${plugin.directory}`);
  }
}

async function waitForApi(server) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`backend exited before becoming ready (code ${server.exitCode})`);
    }
    try {
      const response = await fetch(apiUrl, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        return;
      }
    } catch {
      // The backend has not started listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`backend did not become ready within ${timeoutMs}ms: ${apiUrl}`);
}

function waitForExit(name, child) {
  return new Promise((resolve) => {
    child.once("exit", (code) => resolve({ name, code }));
  });
}

function shutdown(exitCode) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  for (const child of children) {
    stopProcessTree(child.pid);
  }
  process.exitCode = exitCode;
}

function stopProcessTree(pid) {
  if (!pid) {
    return;
  }
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        process.kill(pid, "SIGTERM");
      }
    }
  } catch {
    // The child may already have exited.
  }
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
