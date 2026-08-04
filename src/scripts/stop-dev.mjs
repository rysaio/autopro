import { execFileSync } from "node:child_process";

const ports = [4317, 5317];

function listeningPids(port) {
  const output = execFileSync("netstat", ["-ano"], { encoding: "utf8" });
  return [...new Set(
    output
      .split(/\r?\n/)
      .filter((line) => new RegExp(`127\\.0\\.0\\.1:${port}\\s+.*LISTENING\\s+\\d+$`).test(line))
      .map((line) => line.trim().split(/\s+/).at(-1))
      .filter((pid) => pid && pid !== "0")
  )];
}

for (const port of ports) {
  for (const pid of listeningPids(port)) {
    console.log(`[stop:dev] stopping port ${port}, PID ${pid}`);
    try {
      execFileSync("taskkill", ["/PID", pid, "/T", "/F"], { stdio: "inherit" });
    } catch {
      console.warn(`[stop:dev] could not stop PID ${pid}; run from an elevated terminal if needed.`);
    }
  }
}

