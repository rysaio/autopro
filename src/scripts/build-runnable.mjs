import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const runnableDir = path.resolve(root, "..", "runnable");
const appDir = path.join(runnableDir, "app");

console.log("=== SecOps Agent build:runnable ===\n");

// 1. Build source first so a failed compilation leaves the previous runnable
// package untouched.
console.log("\n[build] 编译所有包...");
execSync("npm run build", { cwd: root, stdio: "inherit" });

// 2. Recreate a clean, self-contained output. Runtime data is intentionally
// discarded on rebuild; the package is a fresh installable release artifact.
if (existsSync(appDir)) {
  rmSync(appDir, { recursive: true, force: true });
  console.log("[clean] removed previous runnable/app");
}
mkdirSync(appDir, { recursive: true });

// 3. Generate the launchers from source templates alongside the app folder.
const launcherTemplateDir = existsSync(path.join(root, "scripts", "templates"))
  ? path.join(root, "scripts", "templates")
  : path.join(root, "src", "scripts", "templates");
for (const launcher of ["start.bat", "stop.bat"]) {
  const template = path.join(launcherTemplateDir, launcher);
  if (!existsSync(template)) {
    console.error(`[error] launcher template is missing: ${template}`);
    process.exit(1);
  }
  cpSync(template, path.join(runnableDir, launcher));
  console.log(`[copy] runnable/${launcher}`);
}

// 4. Copy server dist
const serverDist = path.join(root, "apps", "server", "dist");
if (existsSync(serverDist)) {
  cpSync(serverDist, path.join(appDir, "apps", "server", "dist"), { recursive: true });
  console.log("[copy] apps/server/dist");
} else {
  console.error("[error] apps/server/dist 不存在，请先执行 npm run build");
  process.exit(1);
}

// 5. Copy web dist
const webDist = path.join(root, "apps", "web", "dist");
if (existsSync(webDist)) {
  cpSync(webDist, path.join(appDir, "apps", "web", "dist"), { recursive: true });
  console.log("[copy] apps/web/dist");
} else {
  console.error("[error] apps/web/dist 不存在，请先执行 npm run build");
  process.exit(1);
}

// 6. Copy static-server.mjs
const staticServer = path.join(root, "static-server.mjs");
if (existsSync(staticServer)) {
  cpSync(staticServer, path.join(appDir, "static-server.mjs"));
  console.log("[copy] static-server.mjs");
}

// 7. Copy .env.example
const envExample = path.join(root, ".env.example");
if (existsSync(envExample)) {
  cpSync(envExample, path.join(appDir, ".env.example"));
  console.log("[copy] .env.example");
}

// 8. (removed) secops.config.json is obsolete — model config is now a hot
//    runtime file (runtime/config/model.json) managed via /api/model-config.

// 9. Create production package.json (only runtime deps)
const serverPkg = JSON.parse(readFileSync(path.join(root, "apps", "server", "package.json"), "utf8"));
const prodDeps = {};
for (const [name, ver] of Object.entries(serverPkg.dependencies || {})) {
  // Skip workspace-local deps (they are bundled into the dist)
  if (ver.startsWith("file:")) continue;
  prodDeps[name] = ver;
}
const prodPackage = {
  name: "secops-agent-runnable",
  version: "0.1.0",
  private: true,
  type: "module",
  dependencies: prodDeps
};
writeFileSync(path.join(appDir, "package.json"), JSON.stringify(prodPackage, null, 2) + "\n");
console.log("[create] package.json (production)");

// 10. Create runtime directories placeholder. PGlite requires the complete
// directory tree when resuming a durable data directory; empty directories
// are otherwise easy to lose during packaging or archive extraction.
const runtimeDirs = [
  ["runtime", "pgdata"],
  ["runtime", "pgdata", "pg_commit_ts"],
  ["runtime", "pgdata", "pg_dynshmem"],
  ["runtime", "pgdata", "pg_logical"],
  ["runtime", "pgdata", "pg_logical", "mappings"],
  ["runtime", "pgdata", "pg_logical", "snapshots"],
  ["runtime", "pgdata", "pg_multixact"],
  ["runtime", "pgdata", "pg_multixact", "members"],
  ["runtime", "pgdata", "pg_multixact", "offsets"],
  ["runtime", "pgdata", "pg_notify"],
  ["runtime", "pgdata", "pg_replslot"],
  ["runtime", "pgdata", "pg_serial"],
  ["runtime", "pgdata", "pg_snapshots"],
  ["runtime", "pgdata", "pg_stat"],
  ["runtime", "pgdata", "pg_stat_tmp"],
  ["runtime", "pgdata", "pg_subtrans"],
  ["runtime", "pgdata", "pg_tblspc"],
  ["runtime", "pgdata", "pg_twophase"],
  ["runtime", "pgdata", "pg_wal"],
  ["runtime", "pgdata", "pg_wal", "archive_status"],
  ["runtime", "pgdata", "pg_wal", "summaries"],
  ["runtime", "pgdata", "pg_xact"],
  ["runtime", "sandbox"],
  ["runtime", "audit"],
  ["runtime", "approvals"],
  ["runtime", "config"],
  ["runtime", "skills"],
  ["runtime", "plugins"]
];
for (const parts of runtimeDirs) {
  mkdirSync(path.join(appDir, ...parts), { recursive: true });
}
console.log("[create] runtime/ 目录");

// 11. Provide a usable default config for the fresh package.
const envPath = path.join(appDir, ".env");
if (!existsSync(envPath) && existsSync(envExample)) {
  cpSync(envExample, envPath);
  console.log("[config] created .env from .env.example; update provider credentials before agent runs");
}

// 11b. Seed the default model config template (deepseek, apiKey empty).
// The file is the single source of truth for model config both before and
// after startup: edits are picked up automatically (mtime-based reload).
const modelTemplate = path.join(launcherTemplateDir, "model.json");
if (existsSync(modelTemplate)) {
  cpSync(modelTemplate, path.join(appDir, "runtime", "config", "model.json"));
  console.log("[config] created runtime/config/model.json from template (deepseek default; fill apiKey)");
}

// 12. Generate a production lockfile, then install exactly that lockfile.
// The resulting node_modules is part of the release folder, so start.bat does
// not need network access or a compiler on the first run.
console.log("[install] generating production package-lock.json...");
execSync("npm install --package-lock-only --ignore-scripts --no-audit --no-fund", { cwd: appDir, stdio: "inherit" });
console.log("[install] installing production dependencies...");
execSync("npm ci --omit=dev --no-audit --no-fund", { cwd: appDir, stdio: "inherit" });
console.log("[install] production dependencies ready");

// 13. Install compiled workspace packages into the release. TypeScript emits
// package imports rather than bundling them, so a standalone runnable must not
// rely on a parent workspace node_modules directory for resolution.
// @secops-agent/shared 是主服务的编译期依赖 → node_modules；
// wazuh/shuffle 插件按插件模式（Claude Code / Codex 形态）复制到
// runtime/plugins/<name>/，由主服务启动扫描 / reload 热加载，不再编译期捆绑。
const sharedPackageDir = path.join("packages", "shared");
{
  const sourceDir = path.join(root, sharedPackageDir);
  const packageJson = JSON.parse(readFileSync(path.join(sourceDir, "package.json"), "utf8"));
  const targetDir = path.join(appDir, "node_modules", "@secops-agent", "shared");
  mkdirSync(targetDir, { recursive: true });
  cpSync(path.join(sourceDir, "dist"), path.join(targetDir, "dist"), { recursive: true });
  cpSync(path.join(sourceDir, "package.json"), path.join(targetDir, "package.json"));
  console.log("[copy] workspace runtime package @secops-agent/shared");
}

const pluginPackages = [
  path.join("plugins", "wazuh-secops"),
  path.join("plugins", "shuffle-secops")
];
for (const relativePackageDir of pluginPackages) {
  const sourceDir = path.join(root, relativePackageDir);
  const packageJson = JSON.parse(readFileSync(path.join(sourceDir, "package.json"), "utf8"));
  const pluginName = packageJson.name.split("/").pop();
  const targetDir = path.join(appDir, "runtime", "plugins", pluginName);
  mkdirSync(targetDir, { recursive: true });
  for (const item of ["dist", "package.json", ".mcp.json", ".codex-plugin", "skills", "README.md"]) {
    const sourceItem = path.join(sourceDir, item);
    if (existsSync(sourceItem)) {
      cpSync(sourceItem, path.join(targetDir, item), { recursive: true });
    }
  }
  console.log(`[copy] plugin runtime/plugins/${pluginName}`);
}

console.log(`\n=== 构建完成 ===`);
console.log(`可运行包: ${runnableDir}`);
console.log(`启动: 双击 runnable/start.bat`);
