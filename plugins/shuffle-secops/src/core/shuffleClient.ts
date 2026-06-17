import { loadShuffleConfig, type ShuffleConfig } from "./configStatus.js";

export interface ShuffleClientRequestOptions {
  method?: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
}

export class ShuffleApiError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = "ShuffleApiError";
  }
}

export class ShuffleClient {
  constructor(
    private readonly config: ShuffleConfig = loadShuffleConfig(),
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  endpointHost(): string {
    return this.config.apiUrl.host;
  }

  async health(): Promise<unknown> {
    return this.request("/workflows", { query: { limit: 1 } });
  }

  async listWorkflows(query: Record<string, string | number | undefined> = {}): Promise<unknown> {
    return this.request("/workflows", { query });
  }

  async getWorkflow(workflowId: string): Promise<unknown> {
    return this.request(`/workflows/${encodeURIComponent(workflowId)}`);
  }

  async executeWorkflow(workflowId: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request(`/workflows/${encodeURIComponent(workflowId)}/execute`, {
      method: "POST",
      body
    });
  }

  async listWorkflowExecutions(workflowId: string, query: Record<string, string | number | undefined> = {}): Promise<unknown> {
    return this.request(`/workflows/${encodeURIComponent(workflowId)}/executions`, { query });
  }

  async getExecutionResult(executionId: string, authorization?: string): Promise<unknown> {
    return this.request("/streams/results", {
      method: "POST",
      body: {
        execution_id: executionId,
        ...(authorization ? { authorization } : {})
      }
    });
  }

  async listApps(query: Record<string, string | number | undefined> = {}): Promise<unknown> {
    return this.request("/apps", { query });
  }

  async callShuffleMcp(body: Record<string, unknown>): Promise<unknown> {
    return this.request("/mcp", {
      method: "POST",
      body
    });
  }

  async triggerWebhook(input: {
    webhookUrl: string;
    method: "GET" | "POST";
    payload?: Record<string, unknown>;
    headers?: Record<string, string>;
  }): Promise<unknown> {
    const url = validatedUrl(input.webhookUrl, "webhookUrl");
    const headers = input.headers ?? {};
    const response = await this.fetchImpl(url, {
      method: input.method,
      headers: input.method === "POST" ? { "content-type": "application/json", ...headers } : headers,
      ...(input.method === "POST" ? { body: JSON.stringify(input.payload ?? {}) } : {})
    });
    return parseResponse(response);
  }

  async request(path: string, options: ShuffleClientRequestOptions = {}): Promise<unknown> {
    const url = new URL(`${this.config.apiUrl.pathname.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`, this.config.apiUrl);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Bearer ${this.config.apiKey}`,
      ...(this.config.orgId ? { "Org-Id": this.config.orgId } : {}),
      ...(options.headers ?? {})
    };
    const init: RequestInit = {
      method: options.method ?? "GET",
      headers,
      signal: AbortSignal.timeout(this.config.timeoutMs)
    };
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }
    const response = await this.fetchImpl(url, init);
    return parseResponse(response);
  }
}

export function validatedUrl(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label} must use http or https`);
  }
  if (url.username || url.password) {
    throw new Error(`${label} must not include credentials`);
  }
  return url.toString();
}

async function parseResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  const body = parseBody(text);
  if (!response.ok) {
    throw new ShuffleApiError(`Shuffle API request failed with HTTP ${response.status}: ${safeErrorText(body, text)}`, response.status);
  }
  return body;
}

function parseBody(text: string): unknown {
  if (!text.trim()) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function safeErrorText(body: unknown, fallback: string): string {
  const text = typeof body === "string" ? body : JSON.stringify(body ?? fallback);
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/"apikey"\s*:\s*"[^"]+"/gi, '"apikey":"[redacted]"')
    .replace(/"api_key"\s*:\s*"[^"]+"/gi, '"api_key":"[redacted]"')
    .slice(0, 500);
}
