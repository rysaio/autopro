import type { EvidenceArtifact } from "./types.js";

export function affectedItems(value: unknown): unknown[] {
  if (isRecord(value) && isRecord(value.data) && Array.isArray(value.data.affected_items)) {
    return value.data.affected_items;
  }
  if (isRecord(value) && Array.isArray(value.affected_items)) {
    return value.affected_items;
  }
  return [];
}

export function totalItems(value: unknown): number | undefined {
  if (isRecord(value) && isRecord(value.data) && typeof value.data.total_affected_items === "number") {
    return value.data.total_affected_items;
  }
  if (isRecord(value) && typeof value.total_affected_items === "number") {
    return value.total_affected_items;
  }
  return undefined;
}

export function agentSummary(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    return { raw: value };
  }
  return {
    id: value.id,
    name: value.name,
    ip: value.ip,
    status: value.status,
    groups: value.group ?? value.groups,
    os: value.os,
    lastKeepAlive: value.lastKeepAlive ?? value.last_keep_alive,
    labels: value.labels
  };
}

export function netaddrSummary(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    return { raw: value };
  }
  return {
    iface: value.iface,
    proto: value.proto,
    address: value.address,
    netmask: value.netmask,
    broadcast: value.broadcast
  };
}

export function netifaceSummary(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    return { raw: value };
  }
  return {
    name: value.name,
    adapter: value.adapter,
    type: value.type,
    state: value.state,
    mac: value.mac,
    mtu: value.mtu,
    rxBytes: value.rx_bytes,
    txBytes: value.tx_bytes
  };
}

export function portSummary(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    return { raw: value };
  }
  return {
    protocol: value.protocol,
    localIp: value.local_ip,
    localPort: value.local_port,
    remoteIp: value.remote_ip,
    remotePort: value.remote_port,
    state: value.state,
    pid: value.pid,
    process: value.process
  };
}

export function processSummary(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    return { raw: value };
  }
  return {
    pid: value.pid,
    name: value.name,
    state: value.state,
    ppid: value.ppid,
    euser: value.euser,
    command: value.cmd,
    startTime: value.start_time
  };
}

export function relatedProcessSummaries(
  portRecords: Array<Record<string, unknown>>,
  processRecords: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  const portPids = new Set(
    portRecords
      .map((port) => port.pid)
      .filter((pid): pid is string | number => typeof pid === "string" || typeof pid === "number")
      .map((pid) => String(pid))
  );
  if (!portPids.size) {
    return [];
  }
  return processRecords.filter((process) => {
    const pid = process.pid;
    return (typeof pid === "string" || typeof pid === "number") && portPids.has(String(pid));
  });
}

export function alertHits(value: unknown): unknown[] {
  if (!isRecord(value) || !isRecord(value.hits) || !Array.isArray(value.hits.hits)) {
    return [];
  }
  return value.hits.hits;
}

export function alertTotal(value: unknown): number | undefined {
  if (!isRecord(value) || !isRecord(value.hits)) {
    return undefined;
  }
  if (typeof value.hits.total === "number") {
    return value.hits.total;
  }
  if (isRecord(value.hits.total) && typeof value.hits.total.value === "number") {
    return value.hits.total.value;
  }
  return undefined;
}

export function alertSummary(value: unknown): Record<string, unknown> {
  const source = isRecord(value) && isRecord(value._source) ? value._source : value;
  if (!isRecord(source)) {
    return { raw: source };
  }
  const data = isRecord(source.data) ? source.data : {};
  const agent = isRecord(source.agent) ? source.agent : {};
  const rule = isRecord(source.rule) ? source.rule : {};
  return {
    timestamp: source.timestamp,
    agent: {
      id: agent.id,
      name: agent.name,
      ip: agent.ip
    },
    rule: {
      id: rule.id,
      level: rule.level,
      description: rule.description
    },
    sourceIp: data.srcip ?? data.src_ip ?? source.source_ip,
    location: source.location,
    fullLog: source.full_log
  };
}

export function extractVersion(value: unknown): string | undefined {
  const data = isRecord(value) && isRecord(value.data) ? value.data : value;
  if (!isRecord(data)) {
    return undefined;
  }
  return stringField(data, ["api_version", "version", "revision"]);
}

export function extractUser(value: unknown): unknown {
  const item = affectedItems(value)[0];
  if (isRecord(item)) {
    return {
      username: item.username ?? item.name,
      roles: item.roles
    };
  }
  return undefined;
}

export function artifact(title: string, summary: string, data: unknown): EvidenceArtifact {
  return {
    id: crypto.randomUUID(),
    kind: "runtime",
    title,
    summary,
    data,
    createdAt: new Date().toISOString()
  };
}

function stringField(value: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof value[key] === "string") {
      return value[key];
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
