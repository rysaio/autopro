import type {
  ApprovalDecisionResult,
  AgentRun,
  AgentRunEvent,
  AgentRunRequest,
  AgentSessionDetail,
  AgentSessionSummary,
  AutomationLevel,
  EvidenceArtifact,
  PendingApproval,
  PermissionMode,
  ProviderStatus,
  RuntimeSettings,
  SkillPackManifest,
  SkillManifest,
  ToolInvocation
} from "@secops-agent/shared";

const viteEnv = import.meta.env ?? {};
const API_BASE = viteEnv.VITE_API_BASE_URL || "";
const API_TOKEN = viteEnv.VITE_API_TOKEN || storageApiToken() || "";
const DEFAULT_AGENT_STREAM_TIMEOUT_MS = 5 * 60 * 1000;
const AGENT_STREAM_TIMEOUT_MS = parseTimeoutMs(
  viteEnv.VITE_AGENT_STREAM_TIMEOUT_MS,
  DEFAULT_AGENT_STREAM_TIMEOUT_MS
);

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: authHeaders()
  });
  if (!response.ok) {
    throw new Error(`${path} failed with ${response.status}`);
  }
  return response.json() as Promise<T>;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders()
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${path} failed with ${response.status}: ${text}`);
  }
  return response.json() as Promise<T>;
}

export function fetchHealth(): Promise<ProviderStatus> {
  return getJson<ProviderStatus>("/api/health");
}

export function updateActionLevel(actionLevel: AutomationLevel): Promise<RuntimeSettings> {
  return postJson<RuntimeSettings>("/api/settings/action-level", { actionLevel });
}

export async function fetchTools(): Promise<SkillManifest[]> {
  const result = await getJson<{ tools: SkillManifest[] }>("/api/tools");
  return result.tools;
}

export async function fetchSkills(): Promise<SkillPackManifest[]> {
  const result = await getJson<{ skills: SkillPackManifest[] }>("/api/skills");
  return result.skills;
}

export function runAgent(request: AgentRunRequest): Promise<AgentRun> {
  return postJson<AgentRun>("/api/agent/run", request);
}

export async function streamAgent(
  request: AgentRunRequest,
  onEvent: (event: AgentRunEvent) => void
): Promise<AgentRun> {
  const controller = new AbortController();
  let didTimeout = false;
  const timeoutId = AGENT_STREAM_TIMEOUT_MS > 0
    ? window.setTimeout(() => {
        didTimeout = true;
        controller.abort();
      }, AGENT_STREAM_TIMEOUT_MS)
    : undefined;

  try {
    const response = await fetch(`${API_BASE}/api/agent/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders()
      },
      body: JSON.stringify(request),
      signal: controller.signal
    });
    if (!response.ok || !response.body) {
      const text = await response.text();
      throw new Error(`/api/agent/events failed with ${response.status}: ${text}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finalRun: AgentRun | null = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const parsed = drainSseEvents(buffer, onEvent);
      buffer = parsed.remainder;
      if (parsed.finalRun) {
        finalRun = parsed.finalRun;
      }
    }

    buffer += decoder.decode();
    const parsed = drainSseEvents(buffer, onEvent);
    if (parsed.finalRun) {
      finalRun = parsed.finalRun;
    }
    if (!finalRun) {
      throw new Error("Agent event stream ended without a final run.");
    }
    return finalRun;
  } catch (error) {
    if (didTimeout || isAbortError(error)) {
      throw new Error(`Agent event stream timed out after ${formatTimeoutMs(AGENT_STREAM_TIMEOUT_MS)}.`);
    }
    throw error;
  } finally {
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
    }
  }
}

export interface McpToolSummary {
  name: string;
  manifest: SkillManifest;
}

export interface McpCallResult {
  invocation: ToolInvocation;
  artifacts: EvidenceArtifact[];
}

export async function fetchMcpTools(): Promise<McpToolSummary[]> {
  const result = await getJson<{ tools: McpToolSummary[] }>("/api/mcp/tools");
  return result.tools;
}

export function callMcpTool(
  name: string,
  args: Record<string, unknown>,
  permissionMode: PermissionMode,
  sessionId?: string
): Promise<McpCallResult> {
  return postJson<McpCallResult>(`/api/mcp/tools/${name}/call`, {
    args,
    permissionMode,
    sessionId
  });
}

export async function fetchApprovals(): Promise<PendingApproval[]> {
  const result = await getJson<{ approvals: PendingApproval[] }>("/api/approvals");
  return result.approvals;
}

export async function fetchAuditEvents(limit = 50): Promise<AgentRunEvent[]> {
  const result = await getJson<{ events: AgentRunEvent[] }>(`/api/audit/events?limit=${limit}`);
  return result.events;
}

export async function fetchSessions(limit = 50): Promise<AgentSessionSummary[]> {
  const result = await getJson<{ sessions: AgentSessionSummary[] }>(`/api/sessions?limit=${limit}`);
  return result.sessions;
}

export function fetchSession(id: string): Promise<AgentSessionDetail> {
  return getJson<AgentSessionDetail>(`/api/sessions/${encodeURIComponent(id)}`);
}

export function approveToolCall(id: string): Promise<ApprovalDecisionResult> {
  return postJson<ApprovalDecisionResult>(`/api/approvals/${id}/approve`, {});
}

export function denyToolCall(id: string): Promise<ApprovalDecisionResult> {
  return postJson<ApprovalDecisionResult>(`/api/approvals/${id}/deny`, {});
}

function authHeaders(): Record<string, string> {
  return API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : {};
}

function storageApiToken(): string | undefined {
  return typeof localStorage === "undefined" ? undefined : localStorage.getItem("secops.apiToken") ?? undefined;
}

function parseTimeoutMs(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function formatTimeoutMs(value: number): string {
  if (value >= 60_000) {
    return `${Math.round(value / 60_000)} minute(s)`;
  }
  return `${Math.round(value / 1000)} second(s)`;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function drainSseEvents(
  input: string,
  onEvent: (event: AgentRunEvent) => void
): { remainder: string; finalRun: AgentRun | null } {
  const normalized = input.replace(/\r\n/g, "\n");
  const chunks = normalized.split("\n\n");
  const remainder = chunks.pop() ?? "";
  let finalRun: AgentRun | null = null;
  for (const chunk of chunks) {
    const data = chunk
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) {
      continue;
    }
    const event = JSON.parse(data) as AgentRunEvent;
    onEvent(event);
    if (event.type === "run_completed" && event.run) {
      finalRun = event.run;
    }
  }
  return { remainder, finalRun };
}
