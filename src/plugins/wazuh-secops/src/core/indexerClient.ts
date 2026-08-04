import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { IncomingHttpHeaders } from "node:http";

export interface WazuhIndexerConfig {
  indexerUrl: URL;
  username: string;
  password: string;
  alertsIndex: string;
  tlsVerify: boolean;
  caCertPath: string | undefined;
  timeoutMs: number;
}

export interface WazuhAlertSearchInput {
  relatedIp?: string;
  sourceIp?: string;
  destinationIp?: string;
  agentId?: string;
  ruleId?: string;
  timeWindowMinutes: number;
  limit: number;
}

export class WazuhIndexerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WazuhIndexerConfigError";
  }
}

export class WazuhIndexerApiError extends Error {
  constructor(
    message: string,
    readonly statusCode?: number
  ) {
    super(message);
    this.name = "WazuhIndexerApiError";
  }
}

export function loadWazuhIndexerConfig(env: NodeJS.ProcessEnv = process.env): WazuhIndexerConfig {
  if (isWazuhDemoMode(env)) {
    return {
      indexerUrl: new URL("http://demo-indexer.local:9200"),
      username: "demo",
      password: "demo",
      alertsIndex: "wazuh-alerts-*",
      tlsVerify: false,
      caCertPath: undefined,
      timeoutMs: 15_000
    };
  }

  const missing = [
    env.WAZUH_INDEXER_URL?.trim() ? undefined : "WAZUH_INDEXER_URL",
    env.WAZUH_INDEXER_USER?.trim() ? undefined : "WAZUH_INDEXER_USER",
    env.WAZUH_INDEXER_PASSWORD?.trim() ? undefined : "WAZUH_INDEXER_PASSWORD"
  ].filter((item): item is string => Boolean(item));

  if (missing.length) {
    throw new WazuhIndexerConfigError(`Missing Wazuh Indexer configuration: ${missing.join(", ")}`);
  }

  const indexerUrl = new URL(env.WAZUH_INDEXER_URL as string);
  if (indexerUrl.username || indexerUrl.password) {
    throw new WazuhIndexerConfigError("WAZUH_INDEXER_URL must not include credentials");
  }

  return {
    indexerUrl,
    username: env.WAZUH_INDEXER_USER as string,
    password: env.WAZUH_INDEXER_PASSWORD as string,
    alertsIndex: env.WAZUH_ALERTS_INDEX?.trim() || "wazuh-alerts-*",
    tlsVerify: (env.WAZUH_INDEXER_TLS_VERIFY ?? env.WAZUH_TLS_VERIFY)?.trim().toLowerCase() !== "false",
    caCertPath: env.WAZUH_INDEXER_CA_CERT_PATH?.trim() || env.WAZUH_CA_CERT_PATH?.trim() || undefined,
    timeoutMs: parsePositiveInteger(
      env.WAZUH_INDEXER_REQUEST_TIMEOUT_MS || env.WAZUH_REQUEST_TIMEOUT_MS,
      15_000,
      "WAZUH_INDEXER_REQUEST_TIMEOUT_MS"
    )
  };
}

// ---------------------------------------------------------------------------
// Demo Indexer Client
// ---------------------------------------------------------------------------

function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isWazuhDemoMode(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.SECOPS_DEMO_MODE?.trim().toLowerCase() === "true") {
    return true;
  }
  const apiUrl = env.WAZUH_INDEXER_URL?.trim();
  return !apiUrl || apiUrl.toLowerCase() === "demo";
}

const MOCK_ALERTS = [
  {
    _index: "wazuh-alerts-4.x-2024.01.15",
    _id: "alert-001",
    _score: 1.0,
    _source: {
      timestamp: new Date(Date.now() - 120_000).toISOString(),
      agent: { id: "001", name: "web-server-01", ip: "10.0.1.10" },
      rule: { id: "5710", level: 5, description: "sshd: Attempt to login using a non-existent user", groups: ["syslog", "sshd", "authentication_failed"] },
      data: { srcip: "192.168.10.50", srcport: "54321", dstip: "10.0.1.10", dstport: "22" },
      location: "sshd",
      full_log: "Failed password for invalid user admin from 192.168.10.50 port 54321 ssh2"
    }
  },
  {
    _index: "wazuh-alerts-4.x-2024.01.15",
    _id: "alert-002",
    _score: 1.0,
    _source: {
      timestamp: new Date(Date.now() - 300_000).toISOString(),
      agent: { id: "001", name: "web-server-01", ip: "10.0.1.10" },
      rule: { id: "5716", level: 5, description: "sshd: Authentication failure.", groups: ["syslog", "sshd", "authentication_failed"] },
      data: { srcip: "203.0.113.45", srcport: "61234", dstip: "10.0.1.10", dstport: "22" },
      location: "sshd",
      full_log: "Failed password for root from 203.0.113.45 port 61234 ssh2"
    }
  },
  {
    _index: "wazuh-alerts-4.x-2024.01.15",
    _id: "alert-003",
    _score: 1.0,
    _source: {
      timestamp: new Date(Date.now() - 600_000).toISOString(),
      agent: { id: "003", name: "db-server-01", ip: "10.0.2.20" },
      rule: { id: "1002", level: 2, description: "Unknown problem somewhere in the system.", groups: ["syslog", "errors"] },
      data: { srcip: "10.0.2.20" },
      location: "/var/log/messages",
      full_log: "kernel: [UFW BLOCK] IN=eth0 OUT= MAC=08:00:27:ab:cd:ef SRC=10.0.1.10 DST=10.0.2.20 LEN=60 TOS=0x00 PREC=0x00 TTL=64 ID=12345 DF PROTO=TCP SPT=443 DPT=3306 WINDOW=65535 RES=0x00 SYN URGP=0"
    }
  },
  {
    _index: "wazuh-alerts-4.x-2024.01.15",
    _id: "alert-004",
    _score: 1.0,
    _source: {
      timestamp: new Date(Date.now() - 900_000).toISOString(),
      agent: { id: "002", name: "web-server-02", ip: "10.0.1.11" },
      rule: { id: "31151", level: 10, description: "Multiple authentication failures from same source IP.", groups: ["syslog", "sshd", "authentication_failures"] },
      data: { srcip: "198.51.100.22", srcport: "49876", dstip: "10.0.1.11", dstport: "22" },
      location: "sshd",
      full_log: "sshd: Multiple authentication failures from 198.51.100.22"
    }
  },
  {
    _index: "wazuh-alerts-4.x-2024.01.15",
    _id: "alert-005",
    _score: 1.0,
    _source: {
      timestamp: new Date(Date.now() - 1_200_000).toISOString(),
      agent: { id: "001", name: "web-server-01", ip: "10.0.1.10" },
      rule: { id: "31501", level: 10, description: "Multiple web server 400 error codes from same source IP.", groups: ["web", "accesslog", "attack"] },
      data: { srcip: "203.0.113.45", srcport: "52341", dstip: "10.0.1.10", dstport: "443" },
      location: "nginx-access",
      full_log: "203.0.113.45 - - [15/Jan/2024:08:00:00 +0000] \"GET /wp-admin/setup-config.php HTTP/1.1\" 404 162 \"-\" \"Mozilla/5.0\""
    }
  },
  {
    _index: "wazuh-alerts-4.x-2024.01.15",
    _id: "alert-006",
    _score: 1.0,
    _source: {
      timestamp: new Date(Date.now() - 1_800_000).toISOString(),
      agent: { id: "001", name: "web-server-01", ip: "10.0.1.10" },
      rule: { id: "5503", level: 5, description: "User authentication failure via PAM.", groups: ["syslog", "pam", "authentication_failed"] },
      data: { srcip: "10.0.1.10", dstip: "10.0.1.10" },
      location: "pam_unix",
      full_log: "pam_unix(sshd:auth): authentication failure; logname= uid=0 euid=0 tty=ssh ruser= rhost=192.168.10.50 user=root"
    }
  },
  {
    _index: "wazuh-alerts-4.x-2024.01.15",
    _id: "alert-007",
    _score: 1.0,
    _source: {
      timestamp: new Date(Date.now() - 2_400_000).toISOString(),
      agent: { id: "004", name: "dev-workstation-01", ip: "192.168.10.50" },
      rule: { id: "602", level: 6, description: "Windows audit failure event.", groups: ["windows", "audit"] },
      data: { srcip: "192.168.10.50", dstip: "10.0.1.10" },
      location: "EventChannel",
      full_log: "Microsoft-Windows-Security-Auditing: An account failed to log on. Subject: Security ID: S-1-5-18 Account Name: DEV-WORKSTATION-01$ Account Domain: CORP"
    }
  },
  {
    _index: "wazuh-alerts-4.x-2024.01.15",
    _id: "alert-008",
    _score: 1.0,
    _source: {
      timestamp: new Date(Date.now() - 3_600_000).toISOString(),
      agent: { id: "005", name: "monitoring-01", ip: "10.0.3.30" },
      rule: { id: "510", level: 0, description: "System event: service started.", groups: ["syslog", "system"] },
      data: { srcip: "10.0.3.30" },
      location: "systemd",
      full_log: "systemd: Started Prometheus Node Exporter."
    }
  }
];

function mockIndexerResponse(hits: unknown[], total?: number): unknown {
  return {
    took: 15,
    timed_out: false,
    _shards: { total: 5, successful: 5, skipped: 0, failed: 0 },
    hits: {
      total: { value: total ?? hits.length, relation: "eq" },
      max_score: 1.0,
      hits
    }
  };
}

export class DemoWazuhIndexerClient {
  endpointHost(): string {
    return "demo-indexer.local:9200";
  }

  alertsIndex(): string {
    return "wazuh-alerts-*";
  }

  async searchAlerts(input: WazuhAlertSearchInput): Promise<unknown> {
    await delayMs(90);
    let alerts = [...MOCK_ALERTS];

    if (input.agentId) {
      alerts = alerts.filter((a) => {
        const agent = (a._source as Record<string, unknown>).agent as Record<string, unknown> | undefined;
        return agent?.id === input.agentId;
      });
    }

    if (input.ruleId) {
      alerts = alerts.filter((a) => {
        const rule = (a._source as Record<string, unknown>).rule as Record<string, unknown> | undefined;
        return rule?.id === input.ruleId;
      });
    }

    if (input.sourceIp) {
      alerts = alerts.filter((a) => {
        const data = (a._source as Record<string, unknown>).data as Record<string, unknown> | undefined;
        return data?.srcip === input.sourceIp || data?.src_ip === input.sourceIp;
      });
    }

    if (input.destinationIp) {
      alerts = alerts.filter((a) => {
        const data = (a._source as Record<string, unknown>).data as Record<string, unknown> | undefined;
        return data?.dstip === input.destinationIp || data?.dst_ip === input.destinationIp;
      });
    }

    if (input.relatedIp) {
      alerts = alerts.filter((a) => {
        const data = (a._source as Record<string, unknown>).data as Record<string, unknown> | undefined;
        const agent = (a._source as Record<string, unknown>).agent as Record<string, unknown> | undefined;
        return data?.srcip === input.relatedIp ||
          data?.src_ip === input.relatedIp ||
          data?.dstip === input.relatedIp ||
          data?.dst_ip === input.relatedIp ||
          agent?.ip === input.relatedIp;
      });
    }

    const limit = input.limit;
    const sliced = alerts.slice(0, limit);
    return mockIndexerResponse(sliced, alerts.length);
  }
}

// ---------------------------------------------------------------------------
// Real Indexer Client
// ---------------------------------------------------------------------------

export class WazuhIndexerClient {
  constructor(private readonly config: WazuhIndexerConfig = loadWazuhIndexerConfig()) {}

  endpointHost(): string {
    return this.config.indexerUrl.host;
  }

  alertsIndex(): string {
    return this.config.alertsIndex;
  }

  async searchAlerts(input: WazuhAlertSearchInput): Promise<unknown> {
    const body = alertSearchBody(input);
    return (await rawRequest(this.config, "POST", `/${encodeURIComponent(this.config.alertsIndex)}/_search`, body)).data;
  }
}

export function alertSearchBody(input: WazuhAlertSearchInput): Record<string, unknown> {
  const filter: unknown[] = [
    {
      range: {
        timestamp: {
          gte: `now-${input.timeWindowMinutes}m`
        }
      }
    }
  ];
  if (input.agentId) {
    filter.push({ term: { "agent.id": input.agentId } });
  }
  if (input.ruleId) {
    filter.push({ term: { "rule.id": input.ruleId } });
  }
  if (input.sourceIp) {
    filter.push({
      bool: {
        should: [
          { term: { "data.srcip": input.sourceIp } },
          { term: { "data.src_ip": input.sourceIp } },
          { term: { "source.ip": input.sourceIp } },
          { term: { "srcip": input.sourceIp } }
        ],
        minimum_should_match: 1
      }
    });
  }
  if (input.destinationIp) {
    filter.push({
      bool: {
        should: [
          { term: { "data.dstip": input.destinationIp } },
          { term: { "data.dst_ip": input.destinationIp } },
          { term: { "destination.ip": input.destinationIp } },
          { term: { "dstip": input.destinationIp } }
        ],
        minimum_should_match: 1
      }
    });
  }
  if (input.relatedIp) {
    filter.push({
      bool: {
        should: [
          { term: { "data.srcip": input.relatedIp } },
          { term: { "data.src_ip": input.relatedIp } },
          { term: { "source.ip": input.relatedIp } },
          { term: { "srcip": input.relatedIp } },
          { term: { "data.dstip": input.relatedIp } },
          { term: { "data.dst_ip": input.relatedIp } },
          { term: { "destination.ip": input.relatedIp } },
          { term: { "dstip": input.relatedIp } },
          { term: { "agent.ip": input.relatedIp } }
        ],
        minimum_should_match: 1
      }
    });
  }
  return {
    size: input.limit,
    sort: [
      {
        timestamp: {
          order: "desc"
        }
      }
    ],
    query: {
      bool: {
        filter
      }
    }
  };
}

async function rawRequest(
  config: WazuhIndexerConfig,
  method: string,
  pathname: string,
  body: unknown
): Promise<{ statusCode: number; headers: IncomingHttpHeaders; data: unknown }> {
  const url = new URL(pathname, config.indexerUrl);
  const payload = JSON.stringify(body);
  const requester = url.protocol === "https:" ? httpsRequest : httpRequest;
  const credentials = Buffer.from(`${config.username}:${config.password}`).toString("base64");

  return new Promise((resolve, reject) => {
    const request = requester({
      method,
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload).toString()
      },
      timeout: config.timeoutMs,
      rejectUnauthorized: config.tlsVerify,
      ca: config.caCertPath ? readFileSync(config.caCertPath, "utf8") : undefined
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("error", (error) => reject(new WazuhIndexerApiError(`Wazuh Indexer ${method} ${pathname} response error: ${error.message}`)));
      response.on("end", () => {
        const data = parseResponse(Buffer.concat(chunks).toString("utf8"));
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          reject(new WazuhIndexerApiError(
            `Wazuh Indexer ${method} ${pathname} failed with HTTP ${response.statusCode}: ${safeDetail(data)}`,
            response.statusCode
          ));
          return;
        }
        resolve({
          statusCode: response.statusCode,
          headers: response.headers,
          data
        });
      });
    });
    request.on("timeout", () => {
      request.destroy(new WazuhIndexerApiError(`Wazuh Indexer ${method} ${pathname} timed out after ${config.timeoutMs}ms`));
    });
    request.on("error", (error) => reject(error));
    request.write(payload);
    request.end();
  });
}

function parseResponse(text: string): unknown {
  if (!text.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (!value?.trim()) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new WazuhIndexerConfigError(`${name} must be a positive integer`);
  }
  return parsed;
}

function safeDetail(value: unknown): string {
  return JSON.stringify(value)
    .replace(/Basic\s+[A-Za-z0-9+/=-]+/gi, "Basic [redacted]")
    .replace(/"token"\s*:\s*"[^"]+"/gi, "\"token\":\"[redacted]\"")
    .replace(/"password"\s*:\s*"[^"]+"/gi, "\"password\":\"[redacted]\"")
    .slice(0, 500);
}