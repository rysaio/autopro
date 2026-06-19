import { spawn } from "node:child_process";
import { Pool } from "pg";

const defaultConnectionString = "postgres://secops_agent:secops_agent@127.0.0.1:55432/secops_agent_test";
const connectionString = process.env.SECOPS_TEST_DATABASE_URL?.trim() || defaultConnectionString;
const skipCompose = process.argv.includes("--no-compose") || process.env.SECOPS_POSTGRES_SKIP_COMPOSE_UP === "true";
const serverTestFiles = [
  "postgresSessionStore.test.ts",
  "agentRequest.test.ts",
  "approval.test.ts"
];

if (!skipCompose) {
  await run("docker", ["compose", "up", "-d", "postgres"]);
}

await waitForPostgres(connectionString);

const npm = npmInvocation();
await run(npm.command, [
  ...npm.args,
  "run",
  "test",
  "-w",
  "@secops-agent/server",
  "--",
  ...serverTestFiles
], {
  SECOPS_TEST_DATABASE_URL: connectionString
});

async function waitForPostgres(url) {
  const deadline = Date.now() + 60_000;
  let lastError;
  while (Date.now() < deadline) {
    const pool = new Pool({
      connectionString: url,
      max: 1,
      idleTimeoutMillis: 1_000,
      connectionTimeoutMillis: 2_000
    });
    try {
      await pool.query("select 1");
      await pool.end();
      return;
    } catch (error) {
      lastError = error;
      await pool.end().catch(() => undefined);
      await sleep(1_000);
    }
  }
  throw new Error(`Postgres did not become ready in time: ${lastError?.message ?? "unknown error"}`);
}

function run(command, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env: {
        ...process.env,
        ...extraEnv
      }
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with ${code ?? "unknown status"}`));
    });
  });
}

function npmInvocation() {
  const npmCli = process.env.npm_execpath;
  if (npmCli) {
    return {
      command: process.execPath,
      args: [npmCli]
    };
  }
  return {
    command: process.platform === "win32" ? "npm.cmd" : "npm",
    args: []
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
