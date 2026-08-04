import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { IncomingHttpHeaders } from "node:http";

export interface WazuhConfig {
  apiUrl: URL;
  username: string;
  password: string;
  tlsVerify: boolean;
  caCertPath: string | undefined;
  timeoutMs: number;
  blockIpCommands: string[];
  maxBlockDurationSeconds: number;
}

export interface WazuhRequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  authenticated?: boolean;
}

export interface WazuhHttpResult<T = unknown> {
  statusCode: number;
  headers: IncomingHttpHeaders;
  data: T;
}

export type WazuhSyscollectorDataset = "netaddr" | "netiface" | "ports" | "processes";

export class WazuhConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WazuhConfigError";
  }
}

export class WazuhApiError extends Error {
  constructor(
    message: string,
    readonly statusCode?: number
  ) {
    super(message);
    this.name = "WazuhApiError";
  }
}

const DEFAULT_BLOCK_IP_COMMANDS = ["firewall-drop", "firewalld-drop", "route-null", "netsh"];

/**
 * Returns true if the Wazuh plugin is running in demo mode.
 * Demo mode is active when SECOPS_DEMO_MODE=true, or when WAZUH_API_URL is not set or equals "demo".
 */
export function isWazuhDemoMode(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.SECOPS_DEMO_MODE?.trim().toLowerCase() === "true") {
    return true;
  }
  const apiUrl = env.WAZUH_API_URL?.trim();
  return !apiUrl || apiUrl.toLowerCase() === "demo";
}

export function loadWazuhConfig(env: NodeJS.ProcessEnv = process.env): WazuhConfig {
  if (isWazuhDemoMode(env)) {
    return {
      apiUrl: new URL("http://demo.local:55000"),
      username: "demo",
      password: "demo",
      tlsVerify: false,
      caCertPath: undefined,
      timeoutMs: 15_000,
      blockIpCommands: DEFAULT_BLOCK_IP_COMMANDS,
      maxBlockDurationSeconds: 86_400
    };
  }

  const missing = [
    env.WAZUH_API_URL?.trim() ? undefined : "WAZUH_API_URL",
    env.WAZUH_API_USER?.trim() ? undefined : "WAZUH_API_USER",
    env.WAZUH_API_PASSWORD?.trim() ? undefined : "WAZUH_API_PASSWORD"
  ].filter((item): item is string => Boolean(item));

  if (missing.length) {
    throw new WazuhConfigError(`Missing Wazuh configuration: ${missing.join(", ")}`);
  }

  const apiUrl = new URL(env.WAZUH_API_URL as string);
  if (apiUrl.username || apiUrl.password) {
    throw new WazuhConfigError("WAZUH_API_URL must not include credentials");
  }

  const timeoutMs = parsePositiveInteger(env.WAZUH_REQUEST_TIMEOUT_MS, 15_000, "WAZUH_REQUEST_TIMEOUT_MS");
  const maxBlockDurationSeconds = parsePositiveInteger(
    env.WAZUH_MAX_BLOCK_DURATION_SECONDS,
    86_400,
    "WAZUH_MAX_BLOCK_DURATION_SECONDS"
  );

  return {
    apiUrl,
    username: env.WAZUH_API_USER as string,
    password: env.WAZUH_API_PASSWORD as string,
    tlsVerify: env.WAZUH_TLS_VERIFY?.trim().toLowerCase() !== "false",
    caCertPath: env.WAZUH_CA_CERT_PATH?.trim() || undefined,
    timeoutMs,
    blockIpCommands: parseCsv(env.WAZUH_BLOCK_IP_COMMANDS) ?? DEFAULT_BLOCK_IP_COMMANDS,
    maxBlockDurationSeconds
  };
}

// ---------------------------------------------------------------------------
// Demo Wazuh Client
// ---------------------------------------------------------------------------

function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MOCK_AGENTS = [
  {
    id: "001", name: "web-server-01", ip: "10.0.1.10", status: "active",
    group: ["production", "web"],
    os: { name: "Ubuntu", version: "22.04.3 LTS", platform: "ubuntu" },
    lastKeepAlive: new Date(Date.now() - 30_000).toISOString(),
    labels: { env: "production", role: "web" }
  },
  {
    id: "002", name: "web-server-02", ip: "10.0.1.11", status: "active",
    group: ["production", "web"],
    os: { name: "Ubuntu", version: "22.04.3 LTS", platform: "ubuntu" },
    lastKeepAlive: new Date(Date.now() - 25_000).toISOString(),
    labels: { env: "production", role: "web" }
  },
  {
    id: "003", name: "db-server-01", ip: "10.0.2.20", status: "active",
    group: ["production", "database"],
    os: { name: "CentOS", version: "7.9", platform: "centos" },
    lastKeepAlive: new Date(Date.now() - 20_000).toISOString(),
    labels: { env: "production", role: "database" }
  },
  {
    id: "004", name: "dev-workstation-01", ip: "192.168.10.50", status: "active",
    group: ["development"],
    os: { name: "Windows", version: "10.0.19045", platform: "windows" },
    lastKeepAlive: new Date(Date.now() - 60_000).toISOString(),
    labels: { env: "development", role: "workstation" }
  },
  {
    id: "005", name: "monitoring-01", ip: "10.0.3.30", status: "active",
    group: ["production", "monitoring"],
    os: { name: "Debian", version: "12.1", platform: "debian" },
    lastKeepAlive: new Date(Date.now() - 15_000).toISOString(),
    labels: { env: "production", role: "monitoring" }
  },
  {
    id: "006", name: "backup-server-01", ip: "10.0.4.40", status: "disconnected",
    group: ["production", "backup"],
    os: { name: "Ubuntu", version: "20.04.6 LTS", platform: "ubuntu" },
    lastKeepAlive: new Date(Date.now() - 600_000).toISOString(),
    labels: { env: "production", role: "backup" }
  },
  {
    id: "007", name: "dmz-proxy-01", ip: "172.16.1.10", status: "active",
    group: ["dmz", "proxy"],
    os: { name: "Alpine", version: "3.18.4", platform: "alpine" },
    lastKeepAlive: new Date(Date.now() - 10_000).toISOString(),
    labels: { env: "dmz", role: "proxy" }
  }
];

const MOCK_SYSCOLLECTOR_NETADDR = [
  { iface: "eth0", proto: "IPv4", address: "10.0.1.10", netmask: "255.255.255.0", broadcast: "10.0.1.255" },
  { iface: "eth0", proto: "IPv6", address: "fe80::a00:27ff:fe4e:1a10", netmask: "ffff:ffff:ffff:ffff::", broadcast: "" },
  { iface: "lo", proto: "IPv4", address: "127.0.0.1", netmask: "255.0.0.0", broadcast: "" }
];

const MOCK_SYSCOLLECTOR_NETIFACE = [
  { name: "eth0", adapter: "Intel 82540EM", type: "ethernet", state: "up", mac: "08:00:27:4E:1A:10", mtu: 1500, rx_bytes: 4423678901, tx_bytes: 1289345678 },
  { name: "lo", adapter: "", type: "loopback", state: "up", mac: "00:00:00:00:00:00", mtu: 65536, rx_bytes: 125678, tx_bytes: 125678 }
];

const MOCK_SYSCOLLECTOR_PORTS = [
  { protocol: "tcp", local_ip: "0.0.0.0", local_port: 22, remote_ip: "0.0.0.0", remote_port: 0, state: "LISTEN", pid: 1024, process: "sshd" },
  { protocol: "tcp", local_ip: "0.0.0.0", local_port: 80, remote_ip: "0.0.0.0", remote_port: 0, state: "LISTEN", pid: 2048, process: "nginx" },
  { protocol: "tcp", local_ip: "0.0.0.0", local_port: 443, remote_ip: "0.0.0.0", remote_port: 0, state: "LISTEN", pid: 2048, process: "nginx" },
  { protocol: "tcp", local_ip: "127.0.0.1", local_port: 3306, remote_ip: "0.0.0.0", remote_port: 0, state: "LISTEN", pid: 3072, process: "mysqld" },
  { protocol: "tcp", local_ip: "127.0.0.1", local_port: 6379, remote_ip: "0.0.0.0", remote_port: 0, state: "LISTEN", pid: 4096, process: "redis-server" },
  { protocol: "udp", local_ip: "0.0.0.0", local_port: 68, remote_ip: "0.0.0.0", remote_port: 0, state: "", pid: 512, process: "dhclient" }
];

const MOCK_SYSCOLLECTOR_PROCESSES = [
  { pid: 1, name: "systemd", state: "S", ppid: 0, euser: "root", cmd: "/sbin/init", start_time: "2024-01-15T08:00:00Z" },
  { pid: 1024, name: "sshd", state: "S", ppid: 1, euser: "root", cmd: "/usr/sbin/sshd -D", start_time: "2024-01-15T08:00:05Z" },
  { pid: 2048, name: "nginx", state: "S", ppid: 1, euser: "www-data", cmd: "nginx: master process /usr/sbin/nginx", start_time: "2024-01-15T08:00:10Z" },
  { pid: 3072, name: "mysqld", state: "S", ppid: 1, euser: "mysql", cmd: "/usr/sbin/mysqld", start_time: "2024-01-15T08:00:15Z" },
  { pid: 4096, name: "redis-server", state: "S", ppid: 1, euser: "redis", cmd: "/usr/bin/redis-server 127.0.0.1:6379", start_time: "2024-01-15T08:00:20Z" },
  { pid: 5120, name: "node", state: "S", ppid: 1, euser: "appuser", cmd: "/usr/bin/node /opt/app/server.js", start_time: "2024-01-20T12:30:00Z" },
  { pid: 6144, name: "python3", state: "S", ppid: 1, euser: "appuser", cmd: "/usr/bin/python3 /opt/app/worker.py", start_time: "2024-01-20T12:31:00Z" }
];

function mockWazuhResponse(data: unknown): unknown {
  return {
    data: {
      affected_items: Array.isArray(data) ? data : [data],
      total_affected_items: Array.isArray(data) ? data.length : 1,
      total_failed_items: 0,
      failed_items: []
    },
    message: "All selected items returned",
    error: 0
  };
}

export class DemoWazuhClient {
  endpointHost(): string {
    return "demo.local:55000";
  }

  allowedBlockIpCommands(): string[] {
    return [...DEFAULT_BLOCK_IP_COMMANDS];
  }

  maxBlockDurationSeconds(): number {
    return 86_400;
  }

  async health(): Promise<{ root: unknown; user: unknown | undefined }> {
    await delayMs(80);
    return {
      root: {
        data: {
          title: "Wazuh API (Demo Mode)",
          api_version: "4.7.3",
          revision: "40703",
          hostname: "wazuh-server-demo",
          timestamp: new Date().toISOString()
        },
        error: 0
      },
      user: {
        data: {
          affected_items: [{ username: "secops-demo", roles: ["administrator"] }],
          total_affected_items: 1
        },
        error: 0
      }
    };
  }

  async listAgents(query: Record<string, string | number | undefined>): Promise<unknown> {
    await delayMs(100);
    let agents = [...MOCK_AGENTS];
    if (typeof query.status === "string") {
      agents = agents.filter((a) => a.status === query.status);
    }
    if (typeof query.name === "string") {
      const nameLower = query.name.toLowerCase();
      agents = agents.filter((a) => a.name.toLowerCase().includes(nameLower));
    }
    if (typeof query.ip === "string") {
      agents = agents.filter((a) => a.ip === query.ip);
    }
    if (typeof query.group === "string") {
      agents = agents.filter((a) => Array.isArray(a.group) && a.group.includes(query.group as string));
    }
    const limit = typeof query.limit === "number" ? query.limit : agents.length;
    const sliced = agents.slice(0, limit);
    return mockWazuhResponse(sliced);
  }

  async getAgent(agentId: string): Promise<unknown> {
    await delayMs(60);
    const agent = MOCK_AGENTS.find((a) => a.id === agentId);
    if (!agent) {
      return mockWazuhResponse([]);
    }
    return mockWazuhResponse(agent);
  }

  async listSyscollector(
    _agentId: string,
    dataset: WazuhSyscollectorDataset,
    query: Record<string, string | number | undefined>
  ): Promise<unknown> {
    await delayMs(70);
    let data: unknown[];
    switch (dataset) {
      case "netaddr": data = MOCK_SYSCOLLECTOR_NETADDR; break;
      case "netiface": data = MOCK_SYSCOLLECTOR_NETIFACE; break;
      case "ports": data = MOCK_SYSCOLLECTOR_PORTS; break;
      case "processes": data = MOCK_SYSCOLLECTOR_PROCESSES; break;
      default: data = [];
    }
    const limit = typeof query.limit === "number" ? query.limit : data.length;
    const sliced = data.slice(0, limit);
    return mockWazuhResponse(sliced);
  }

  async blockIp(input: {
    ip: string;
    agentIds: string[];
    command: string;
    durationSeconds: number;
    reason: string;
  }): Promise<unknown> {
    await delayMs(120);
    return {
      data: {
        affected_items: input.agentIds.map((agentId) => ({
          agent: agentId,
          command: input.command,
          status: "success",
          message: `[DEMO] IP ${input.ip} blocked on agent ${agentId} for ${input.durationSeconds}s via ${input.command}`,
          error: 0
        })),
        total_affected_items: input.agentIds.length
      },
      message: "[DEMO] Active Response simulated",
      error: 0
    };
  }
}

export class WazuhClient {
  private token: string | undefined;

  constructor(private readonly config: WazuhConfig = loadWazuhConfig()) {}

  endpointHost(): string {
    return this.config.apiUrl.host;
  }

  allowedBlockIpCommands(): string[] {
    return [...this.config.blockIpCommands];
  }

  maxBlockDurationSeconds(): number {
    return this.config.maxBlockDurationSeconds;
  }

  async health(): Promise<{ root: unknown; user: unknown | undefined }> {
    const root = await this.request("GET", "/");
    let user: unknown | undefined;
    try {
      user = (await this.request("GET", "/security/users/me")).data;
    } catch (error) {
      if (!(error instanceof WazuhApiError)) {
        throw error;
      }
    }
    return {
      root: root.data,
      user
    };
  }

  async listAgents(query: Record<string, string | number | undefined>): Promise<unknown> {
    return (await this.request("GET", "/agents", { query })).data;
  }

  async getAgent(agentId: string): Promise<unknown> {
    return (await this.request("GET", `/agents/${encodeURIComponent(agentId)}`)).data;
  }

  async listSyscollector(
    agentId: string,
    dataset: WazuhSyscollectorDataset,
    query: Record<string, string | number | undefined>
  ): Promise<unknown> {
    return (await this.request("GET", `/syscollector/${encodeURIComponent(agentId)}/${dataset}`, { query })).data;
  }

  async blockIp(input: {
    ip: string;
    agentIds: string[];
    command: string;
    durationSeconds: number;
    reason: string;
  }): Promise<unknown> {
    const body = {
      command: input.command,
      custom: false,
      arguments: [input.ip],
      alert: {
        rule: {
          id: "secops-agent-wazuh-block-ip",
          description: input.reason
        },
        data: {
          srcip: input.ip,
          secops_duration_seconds: input.durationSeconds,
          secops_reason: input.reason
        },
        full_log: input.reason
      }
    };
    return (await this.request("PUT", "/active-response", {
      query: {
        agents_list: input.agentIds.join(","),
        wait_for_complete: true
      },
      body
    })).data;
  }

  private async request<T = unknown>(
    method: string,
    pathname: string,
    options: WazuhRequestOptions = {},
    retried = false
  ): Promise<WazuhHttpResult<T>> {
    const headers: Record<string, string> = {
      Accept: "application/json"
    };
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (options.authenticated !== false) {
      headers.Authorization = `Bearer ${await this.getToken()}`;
    }

    const response = await rawRequest<T>(this.config, method, pathname, {
      query: options.query,
      body: options.body,
      headers
    });
    if (response.statusCode === 401 && options.authenticated !== false && !retried) {
      this.token = undefined;
      return this.request(method, pathname, options, true);
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new WazuhApiError(
        `Wazuh API ${method} ${pathname} failed with HTTP ${response.statusCode}: ${safeDetail(response.data)}`,
        response.statusCode
      );
    }
    return response;
  }

  private async getToken(): Promise<string> {
    if (this.token) {
      return this.token;
    }
    const credentials = Buffer.from(`${this.config.username}:${this.config.password}`).toString("base64");
    const response = await rawRequest<unknown>(this.config, "POST", "/security/user/authenticate", {
      query: { raw: true },
      headers: {
        Accept: "application/json, text/plain",
        Authorization: `Basic ${credentials}`
      }
    });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new WazuhApiError(`Wazuh authentication failed with HTTP ${response.statusCode}`, response.statusCode);
    }
    const token = extractToken(response.data);
    if (!token) {
      throw new WazuhApiError("Wazuh authentication did not return a usable token", response.statusCode);
    }
    this.token = token;
    return token;
  }
}

async function rawRequest<T>(
  config: WazuhConfig,
  method: string,
  pathname: string,
  options: {
    query?: Record<string, string | number | boolean | undefined> | undefined;
    body?: unknown;
    headers?: Record<string, string>;
  }
): Promise<WazuhHttpResult<T>> {
  const url = new URL(pathname, config.apiUrl);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  const requester = url.protocol === "https:" ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const request = requester({
      method,
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      headers: {
        ...options.headers,
        ...(payload ? { "Content-Length": Buffer.byteLength(payload).toString() } : {})
      },
      timeout: config.timeoutMs,
      rejectUnauthorized: config.tlsVerify,
      ca: config.caCertPath ? readFileSync(config.caCertPath, "utf8") : undefined
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("error", (error) => reject(new WazuhApiError(`Wazuh API ${method} ${pathname} response error: ${error.message}`)));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          statusCode: response.statusCode ?? 0,
          headers: response.headers,
          data: parseResponse<T>(text, response.headers["content-type"])
        });
      });
    });
    request.on("timeout", () => {
      request.destroy(new WazuhApiError(`Wazuh API ${method} ${pathname} timed out after ${config.timeoutMs}ms`));
    });
    request.on("error", (error) => reject(error));
    if (payload) {
      request.write(payload);
    }
    request.end();
  });
}

function parseResponse<T>(text: string, contentType: IncomingHttpHeaders["content-type"]): T {
  if (!text.trim()) {
    return undefined as T;
  }
  const type = Array.isArray(contentType) ? contentType.join(";") : contentType ?? "";
  if (type.includes("json")) {
    return JSON.parse(text) as T;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as T;
  }
}

function extractToken(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.trim() || undefined;
  }
  if (isRecord(value)) {
    if (typeof value.token === "string") {
      return value.token;
    }
    if (isRecord(value.data) && typeof value.data.token === "string") {
      return value.data.token;
    }
  }
  return undefined;
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (!value?.trim()) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new WazuhConfigError(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseCsv(value: string | undefined): string[] | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  const items = value.split(",").map((item) => item.trim()).filter(Boolean);
  return items.length ? items : undefined;
}

function safeDetail(value: unknown): string {
  return JSON.stringify(value)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/"token"\s*:\s*"[^"]+"/gi, "\"token\":\"[redacted]\"")
    .replace(/"password"\s*:\s*"[^"]+"/gi, "\"password\":\"[redacted]\"")
    .slice(0, 500);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}