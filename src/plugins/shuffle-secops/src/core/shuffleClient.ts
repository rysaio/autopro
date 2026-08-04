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

// ---------------------------------------------------------------------------
// Demo Shuffle Client
// ---------------------------------------------------------------------------

function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MOCK_WORKFLOWS = [
  {
    id: "wf-001",
    name: "SSH Brute Force Response",
    description: "Automated response workflow for SSH brute force attacks. Blocks source IP via firewall and creates ticket.",
    status: "active",
    last_runtime: new Date(Date.now() - 3_600_000).toISOString(),
    created: "2024-01-10T08:00:00Z",
    updated: "2024-01-14T16:30:00Z",
    triggers: [{ type: "webhook", name: "ssh_brute_force_webhook" }],
    actions: [
      { app_name: "Wazuh", app_version: "1.0.0", name: "get_agent_details", id: "act-001" },
      { app_name: "TheHive", app_version: "1.0.0", name: "create_case", id: "act-002" },
      { app_name: "Firewall", app_version: "1.0.0", name: "block_ip", id: "act-003" }
    ]
  },
  {
    id: "wf-002",
    name: "Web Attack Investigation",
    description: "Investigates web application attacks (SQLi, XSS, path traversal) by correlating WAF logs and enriching IOC data.",
    status: "active",
    last_runtime: new Date(Date.now() - 7_200_000).toISOString(),
    created: "2024-01-08T10:00:00Z",
    updated: "2024-01-13T12:00:00Z",
    triggers: [{ type: "webhook", name: "web_attack_webhook" }],
    actions: [
      { app_name: "Wazuh", app_version: "1.0.0", name: "search_alerts", id: "act-004" },
      { app_name: "VirusTotal", app_version: "1.0.0", name: "ip_reputation", id: "act-005" },
      { app_name: "ShuffleTools", app_version: "1.0.0", name: "send_slack_notification", id: "act-006" }
    ]
  },
  {
    id: "wf-003",
    name: "Malware Detection Response",
    description: "Handles malware detection alerts. Quarantines affected host, extracts IOCs, and submits samples to sandbox.",
    status: "active",
    last_runtime: new Date(Date.now() - 14_400_000).toISOString(),
    created: "2024-01-05T14:00:00Z",
    updated: "2024-01-12T09:00:00Z",
    triggers: [{ type: "schedule", name: "every_5m" }, { type: "webhook", name: "malware_webhook" }],
    actions: [
      { app_name: "Wazuh", app_version: "1.0.0", name: "get_agent_details", id: "act-007" },
      { app_name: "VirusTotal", app_version: "1.0.0", name: "file_scan", id: "act-008" },
      { app_name: "Cuckoo", app_version: "1.0.0", name: "submit_file", id: "act-009" },
      { app_name: "TheHive", app_version: "1.0.0", name: "create_alert", id: "act-010" }
    ]
  },
  {
    id: "wf-004",
    name: "Data Exfiltration Alert",
    description: "Detects and responds to potential data exfiltration by monitoring large outbound data transfers and unusual DNS queries.",
    status: "active",
    last_runtime: new Date(Date.now() - 86_400_000).toISOString(),
    created: "2024-01-03T08:00:00Z",
    updated: "2024-01-11T14:00:00Z",
    triggers: [{ type: "webhook", name: "data_exfil_webhook" }],
    actions: [
      { app_name: "Wazuh", app_version: "1.0.0", name: "search_alerts", id: "act-011" },
      { app_name: "ShuffleTools", app_version: "1.0.0", name: "send_email", id: "act-012" },
      { app_name: "TheHive", app_version: "1.0.0", name: "create_case", id: "act-013" }
    ]
  },
  {
    id: "wf-005",
    name: "Vulnerability Scan Triage",
    description: "Processes vulnerability scan results, prioritizes findings by CVSS score, and assigns remediation tasks.",
    status: "inactive",
    last_runtime: new Date(Date.now() - 172_800_000).toISOString(),
    created: "2024-01-01T10:00:00Z",
    updated: "2024-01-10T08:00:00Z",
    triggers: [{ type: "webhook", name: "vuln_scan_webhook" }],
    actions: [
      { app_name: "ShuffleTools", app_version: "1.0.0", name: "csv_parser", id: "act-014" },
      { app_name: "Jira", app_version: "1.0.0", name: "create_issue", id: "act-015" }
    ]
  },
  {
    id: "wf-006",
    name: "Phishing Email Analysis",
    description: "Analyzes reported phishing emails, extracts URLs and attachments, checks reputation, and creates incident reports.",
    status: "active",
    last_runtime: new Date(Date.now() - 4_800_000).toISOString(),
    created: "2024-01-12T12:00:00Z",
    updated: "2024-01-15T09:00:00Z",
    triggers: [{ type: "webhook", name: "phishing_webhook" }],
    actions: [
      { app_name: "Email", app_version: "1.0.0", name: "parse_email", id: "act-016" },
      { app_name: "VirusTotal", app_version: "1.0.0", name: "url_scan", id: "act-017" },
      { app_name: "URLScan.io", app_version: "1.0.0", name: "submit_url", id: "act-018" },
      { app_name: "TheHive", app_version: "1.0.0", name: "create_case", id: "act-019" }
    ]
  }
];

const MOCK_APPS = [
  { id: "app-001", name: "Wazuh", description: "Wazuh SIEM/XDR integration", app_version: "1.0.0", categories: ["SIEM", "Security"] },
  { id: "app-002", name: "TheHive", description: "Security Incident Response Platform", app_version: "1.0.0", categories: ["Case Management", "Security"] },
  { id: "app-003", name: "VirusTotal", description: "File and URL analysis service", app_version: "1.0.0", categories: ["Threat Intelligence"] },
  { id: "app-004", name: "ShuffleTools", description: "Built-in utility tools for Shuffle", app_version: "1.0.0", categories: ["Utilities"] },
  { id: "app-005", name: "Jira", description: "Issue tracking and project management", app_version: "1.0.0", categories: ["Project Management"] },
  { id: "app-006", name: "Slack", description: "Team communication platform", app_version: "1.0.0", categories: ["Communication"] },
  { id: "app-007", name: "Email", description: "Email integration for IMAP/SMTP", app_version: "1.0.0", categories: ["Communication"] },
  { id: "app-008", name: "Cuckoo", description: "Automated malware analysis sandbox", app_version: "1.0.0", categories: ["Malware Analysis"] },
  { id: "app-009", name: "URLScan.io", description: "URL and website scanner", app_version: "1.0.0", categories: ["Threat Intelligence"] },
  { id: "app-010", name: "Firewall", description: "Generic firewall management", app_version: "1.0.0", categories: ["Network Security"] }
];

export class DemoShuffleClient {
  endpointHost(): string {
    return "demo-shuffle.local:3001";
  }

  async health(): Promise<unknown> {
    await delayMs(80);
    return [MOCK_WORKFLOWS[0]];
  }

  async listWorkflows(query: Record<string, string | number | undefined> = {}): Promise<unknown> {
    await delayMs(100);
    let workflows = [...MOCK_WORKFLOWS];
    if (typeof query.query === "string") {
      const q = query.query.toLowerCase();
      workflows = workflows.filter((w) =>
        w.name.toLowerCase().includes(q) || w.description.toLowerCase().includes(q)
      );
    }
    const limit = typeof query.limit === "number" ? query.limit : workflows.length;
    return workflows.slice(0, limit);
  }

  async getWorkflow(workflowId: string): Promise<unknown> {
    await delayMs(60);
    const workflow = MOCK_WORKFLOWS.find((w) => w.id === workflowId);
    if (!workflow) {
      throw new ShuffleApiError(`[DEMO] Workflow ${workflowId} not found in demo catalog`, 404);
    }
    return workflow;
  }

  async executeWorkflow(workflowId: string, body: Record<string, unknown>): Promise<unknown> {
    await delayMs(150);
    const workflow = MOCK_WORKFLOWS.find((w) => w.id === workflowId);
    const executionId = `exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return {
      execution_id: executionId,
      workflow_id: workflowId,
      workflow_name: workflow?.name ?? "unknown",
      status: "RUNNING",
      message: `[DEMO] Workflow ${workflowId} execution simulated. Argument: ${JSON.stringify(body)}`,
      started_at: new Date().toISOString(),
      argument: body
    };
  }

  async listWorkflowExecutions(workflowId: string, query: Record<string, string | number | undefined> = {}): Promise<unknown> {
    await delayMs(80);
    const limit = typeof query.limit === "number" ? query.limit : 5;
    const executions = [];
    for (let i = 0; i < Math.min(limit, 5); i++) {
      executions.push({
        execution_id: `exec-demo-${workflowId}-${i + 1}`,
        id: `exec-demo-${workflowId}-${i + 1}`,
        workflow_id: workflowId,
        status: i === 0 ? "SUCCESS" : i === 1 ? "SUCCESS" : i === 2 ? "FAILURE" : "SKIPPED",
        started_at: new Date(Date.now() - (i + 1) * 3_600_000).toISOString(),
        completed_at: new Date(Date.now() - (i + 1) * 3_600_000 + 30_000).toISOString()
      });
    }
    return executions;
  }

  async getExecutionResult(executionId: string, _authorization?: string): Promise<unknown> {
    await delayMs(100);
    return {
      execution_id: executionId,
      status: "SUCCESS",
      result: {
        output: `[DEMO] Execution ${executionId} completed successfully.`,
        actions: [
          { action: "get_agent_details", status: "SUCCESS", result: { agent_id: "001", agent_name: "web-server-01" } },
          { action: "block_ip", status: "SUCCESS", result: { ip: "203.0.113.45", blocked: true } },
          { action: "create_case", status: "SUCCESS", result: { case_id: "CASE-2024-001" } }
        ]
      },
      started_at: new Date(Date.now() - 60_000).toISOString(),
      completed_at: new Date().toISOString()
    };
  }

  async listApps(query: Record<string, string | number | undefined> = {}): Promise<unknown> {
    await delayMs(80);
    let apps = [...MOCK_APPS];
    if (typeof query.query === "string") {
      const q = query.query.toLowerCase();
      apps = apps.filter((a) =>
        a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q)
      );
    }
    const limit = typeof query.limit === "number" ? query.limit : apps.length;
    return apps.slice(0, limit);
  }

  async callShuffleMcp(body: Record<string, unknown>): Promise<unknown> {
    await delayMs(100);
    const method = typeof body.method === "string" ? body.method : "unknown";
    if (method === "tools/list") {
      return {
        tools: [
          { name: "shuffle_list_workflows", description: "[DEMO] List all available workflows" },
          { name: "shuffle_execute_workflow", description: "[DEMO] Execute a workflow by ID" },
          { name: "shuffle_get_execution", description: "[DEMO] Get execution status" }
        ]
      };
    }
    return {
      method,
      params: body.params,
      result: `[DEMO] Shuffle MCP method '${method}' simulated successfully.`,
      timestamp: new Date().toISOString()
    };
  }

  async triggerWebhook(input: {
    webhookUrl: string;
    method: "GET" | "POST";
    payload?: Record<string, unknown>;
    headers?: Record<string, string>;
  }): Promise<unknown> {
    await delayMs(120);
    return {
      status: "success",
      message: `[DEMO] Webhook ${input.method} ${input.webhookUrl} simulated.`,
      payload: input.payload,
      timestamp: new Date().toISOString()
    };
  }
}

// ---------------------------------------------------------------------------
// Real Shuffle Client
// ---------------------------------------------------------------------------

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

/**
 * Returns true if the Shuffle plugin is running in demo mode.
 * Demo mode is active when SECOPS_DEMO_MODE=true, or when SHUFFLE_API_URL is not set or equals "demo".
 */
export function isShuffleDemoMode(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.SECOPS_DEMO_MODE?.trim().toLowerCase() === "true") {
    return true;
  }
  const apiUrl = env.SHUFFLE_API_URL?.trim();
  return !apiUrl || apiUrl.toLowerCase() === "demo";
}