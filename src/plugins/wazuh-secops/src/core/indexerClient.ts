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
