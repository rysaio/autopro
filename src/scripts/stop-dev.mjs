import { execFileSync } from "node:child_process";

const ports = [4317, 5317];

function windowsListeningPids(port) {
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

function unixListeningPids(port) {
  const pids = new Set();
  try {
    const output = execFileSync("ss", ["-ltnp"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    for (const line of output.split(/\r?\n/)) {
      if (!line.includes(`:${port}`) || !line.includes("LISTEN")) {
        continue;
      }
      for (const match of line.matchAll(/pid=(\d+)/g)) {
        pids.add(match[1]);
      }
    }
    return [...pids];
  } catch {
    // try lsof next
  }
  try {
    const output = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    return [...new Set(output.split(/\r?\n/).map((pid) => pid.trim()).filter((pid) => /^\d+$/.test(pid)))];
  } catch {
    return [];
  }
}

function unixWatcherPids() {
  const output = execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const pids = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!match) continue;
    const [, pid, args] = match;
    if (
      args.includes("tsx watch src/index.ts") ||
      (args.includes("vite") && args.includes("--host")) ||
      (args.includes("npm run dev:server")) ||
      (args.includes("npm run dev:web"))
    ) {
      pids.push(pid);
    }
  }
  return pids;
}

function endpointPort(endpoint) {
  const match = endpoint?.match(/:(\d+)$/);
  return match ? Number(match[1]) : undefined;
}

function killPid(pid, signal) {
  try {
    process.kill(Number(pid), signal);
    return true;
  } catch {
    return false;
  }
}

function stopPids(pids) {
  for (const pid of pids) {
    console.log(`[stop:dev] stopping PID ${pid}`);
    killPid(pid, "SIGTERM");
  }
  if (pids.length > 0) {
    try {
      execFileSync("sleep", ["0.6"], { stdio: "ignore" });
    } catch {
      // no sleep available; continue with best effort
    }
    for (const pid of pids) {
      try {
        process.kill(Number(pid), 0);
        console.log(`[stop:dev] PID ${pid} still alive, sending SIGKILL`);
        killPid(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
}

const listeningPids = process.platform === "win32" ? windowsListeningPids : unixListeningPids;
const pids = new Set();

for (const port of ports) {
  for (const pid of listeningPids(port)) {
    pids.add(pid);
  }
}

if (process.platform !== "win32") {
  for (const pid of unixWatcherPids()) {
    pids.add(pid);
  }
}

if (pids.size === 0) {
  console.log("[stop:dev] no dev-server ports or watcher processes found.");
} else {
  stopPids([...pids]);
}
