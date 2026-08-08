import { execFileSync } from "node:child_process";

const ports = [4317, 5317];

function listeningPids(port) {
  const output = execFileSync("netstat", ["-ano"], { encoding: "utf8" });
  return [...new Set(
    output
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/))
      .filter((fields) => fields[0] === "TCP" && fields[3] === "LISTENING" && endpointPort(fields[1]) === port)
      .map((fields) => fields[4])
      .filter((pid) => pid && pid !== "0")
  )];
}

function endpointPort(endpoint) {
  const match = endpoint?.match(/:(\d+)$/);
  return match ? Number(match[1]) : undefined;
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
