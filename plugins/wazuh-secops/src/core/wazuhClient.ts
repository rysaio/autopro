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

export function loadWazuhConfig(env: NodeJS.ProcessEnv = process.env): WazuhConfig {
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
