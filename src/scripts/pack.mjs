#!/usr/bin/env node
/**
 * pack.mjs — Rebuild the runnable `executable/` bundle from `src/`.
 *
 * Single source of truth is `src/`. This script:
 *   1. verifies the bundled portable Node runtime is present,
 *   2. installs dependencies and compiles every workspace,
 *   3. assembles a clean `executable/app/` containing ONLY runtime artifacts
 *      (compiled `dist/`, `node_modules/`, configs) — no TypeScript sources,
 *   4. refreshes the launcher scripts from `src/packaging/`,
 *   5. scrubs secrets and runtime test artifacts.
 *
 * Run with:  npm run build:exe   (from src/)   or   node scripts/pack.mjs
 *
 * Requires Node.js + npm on PATH (this is a developer build tool; it never
 * ships inside the submission).
 */
import { execSync } from "node:child_process";
import { existsSync, rmSync, mkdirSync, cpSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(SOURCE_ROOT, "..");
const EXEC_ROOT = path.join(REPO_ROOT, "executable");
const APP = path.join(EXEC_ROOT, "app");
const PACKAGING = path.join(SOURCE_ROOT, "packaging");
const NODE_EXE = path.join(EXEC_ROOT, "node", "node.exe");

// Workspaces that produce a publishable @secops-agent/* package.
const WORKSPACES = [
  "packages/shared",
  "plugins/wazuh-secops",
  "plugins/shuffle-secops",
  "apps/server",
  "apps/web"
];
// Files/dirs kept when materializing a workspace package (everything runtime
// needs; never `src/`, `test/`, `scripts/`, or tsconfig).
const PKG_KEEP = ["dist", "package.json", "skills", "README.md", ".mcp.json", ".codex-plugin", "bin"];
// Workspace top-level entries that must never reach the bundle.
const PKG_DROP_TOP = new Set(["src", "test", "tests", "scripts", "node_modules"]);

const SCOPE = "@secops-agent";

function step(msg) {
  console.log(`\n═══ ${msg} ═══`);
}
function run(cmd) {
  console.log(`  $ ${cmd}`);
  execSync(cmd, { cwd: SOURCE_ROOT, stdio: "inherit" });
}
function copyAny(src, dest, options = {}) {
  if (existsSync(src)) {
    cpSync(src, dest, { recursive: true, dereference: true, ...options });
  }
}
// True when any path segment is the @secops-agent scope dir — used to keep the
// scope out of bulk copies so we can materialize real (cycle-free) copies later.
function isScopePath(p, base) {
  return path.relative(base, p).split(path.sep).includes(SCOPE);
}

// ── 1. Preflight ───────────────────────────────────────────────────────────
step("Preflight");
if (!existsSync(NODE_EXE)) {
  console.error(`ERROR: portable runtime missing:\n  ${NODE_EXE}\n` +
    "Place a Windows node.exe there before packing (it is intentionally not built by this script).");
  process.exit(1);
}
console.log(`  portable runtime: ${NODE_EXE} ✓`);

// ── 2. Install + build from src ───────────────────────────────────────────────
step("Install dependencies (npm install)");
run("npm install");
step("Build all workspaces (npm run build)");
run("npm run build");

// ── 3. Reset the app payload ─────────────────────────────────────────────────
step("Reset executable/app");
rmSync(APP, { recursive: true, force: true });
mkdirSync(APP, { recursive: true });

// ── 4. node_modules: bulk copy (third-party), excluding the workspace scope ──
step("Assemble node_modules (third-party)");
const srcNodeModules = path.join(SOURCE_ROOT, "node_modules");
if (!existsSync(srcNodeModules)) {
  console.error("ERROR: src/node_modules missing after npm install.");
  process.exit(1);
}
const destNodeModules = path.join(APP, "node_modules");
cpSync(srcNodeModules, destNodeModules, {
  recursive: true,
  dereference: true,
  filter: (src) => !isScopePath(src, srcNodeModules)
});

// ── 5. Materialize @secops-agent/* as real, source-free copies ──────────────
step("Materialize @secops-agent packages");
for (const ws of WORKSPACES) {
  const wsDir = path.join(SOURCE_ROOT, ws);
  const pkgName = JSON.parse(readFileSync(path.join(wsDir, "package.json"), "utf8")).name; // @secops-agent/x
  const dest = path.join(destNodeModules, ...pkgName.split("/"));
  for (const keep of PKG_KEEP) {
    copyAny(path.join(wsDir, keep), path.join(dest, keep));
  }
  console.log(`  ${pkgName} → node_modules/${pkgName} (dist only)`);
}

// ── 6. Workspace dirs at app root (dist + manifests, NO ts sources) ─────────
step("Assemble app workspaces (dist only)");
for (const ws of WORKSPACES) {
  const wsDir = path.join(SOURCE_ROOT, ws);
  const destDir = path.join(APP, ws);
  copyAny(wsDir, destDir, {
    filter: (src) => {
      const rel = path.relative(wsDir, src);
      if (rel === "") return true;
      const parts = rel.split(path.sep);
      if (parts.includes(SCOPE)) return false;            // resolution falls back to root node_modules
      if (PKG_DROP_TOP.has(parts[0])) return false;       // drop src/test/scripts/nested node_modules
      if (parts.length === 1 && /^tsconfig.*\.json$/.test(parts[0])) return false;
      return true;
    }
  });
}

// ── 7. Root configs + static web server ─────────────────────────────────────
step("Copy root config + web server");
for (const f of ["package.json", "package-lock.json", "secops.config.example.json", ".env.example", "README.md"]) {
  copyAny(path.join(SOURCE_ROOT, f), path.join(APP, f));
}
copyAny(path.join(PACKAGING, "static-server.mjs"), path.join(APP, "static-server.mjs"));

// ── 8. Launchers into executable/ root ──────────────────────────────────────
step("Refresh launcher scripts");
for (const f of ["start.bat", "start-no-postgres.bat", "stop.bat", "README_RUN.txt"]) {
  copyAny(path.join(PACKAGING, f), path.join(EXEC_ROOT, f));
}

// ── 9. Scrub secrets + runtime artifacts ────────────────────────────────────
step("Scrub secrets and runtime artifacts");
for (const p of [path.join(APP, ".env"), path.join(APP, "runtime")]) {
  if (existsSync(p)) {
    rmSync(p, { recursive: true, force: true });
    console.log(`  removed ${path.relative(REPO_ROOT, p)}`);
  }
}

console.log(`\n✔ Pack complete → ${APP}`);
console.log("  Next: copy your real app\\.env into executable/app/ (or rely on .env.example), then run executable/start.bat");
