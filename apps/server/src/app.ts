import cors from "@fastify/cors";
import Fastify from "fastify";
import { timingSafeEqual } from "node:crypto";
import type { LanguageModel } from "ai";
import type {
  AgentRunEvent,
  AgentRunRequest,
  AgentSessionDetail,
  AgentSessionSummary,
  ApprovalDecisionResult,
  AuditEvent,
  PermissionMode,
  ProviderStatus,
  RuntimeSettings
} from "@secops-agent/shared";
import { isModelConfigured, missingModelConfig, type AppConfig } from "./config.js";
import { createAiSdkModel } from "./providers/aiSdkModelFactory.js";
import { AgentRuntime } from "./runtime/agentRuntime.js";
import { AuditLog } from "./runtime/auditLog.js";
import { ApprovalStore } from "./runtime/approvalStore.js";
import { PostgresSessionStore } from "./runtime/postgresSessionStore.js";
import { isAutomationLevel, RuntimeSettingsStore } from "./runtime/runtimeSettings.js";
import { NoopSessionStateStore, type SessionStateStore } from "./runtime/sessionStateStore.js";
import { createSecOpsMcpServer, mcpContext, mcpToolSummaries } from "./mcp/secopsMcpServer.js";
import { registerStreamableMcpRoutes } from "./mcp/streamableHttp.js";
import { ToolRegistry } from "./tools/registry.js";
import type { ToolContext } from "./tools/types.js";

export interface BuildServerOptions {
  createModel?: (config: AppConfig, request: AgentRunRequest) => LanguageModel;
}

export function buildServer(config: AppConfig, options: BuildServerOptions = {}) {
  const app = Fastify({ logger: true });
  const durableSessionStore = config.databaseUrl ? new PostgresSessionStore(config.databaseUrl) : undefined;
  const sessionStateStore: SessionStateStore = durableSessionStore ?? new NoopSessionStateStore();
  const registry = new ToolRegistry(undefined, durableSessionStore ?? new ApprovalStore(config.approvalStorePath));
  const auditLog = new AuditLog(config.auditLogPath);
  const runtimeSettings = new RuntimeSettingsStore(config.runtimeConfigPath, {
    actionLevel: config.actionLevel
  });

  app.addHook("onRequest", async (request, reply) => {
    const host = normalizeHost(request.headers.host);
    if (!host || !isAllowed(host, config.allowedHosts)) {
      return reply.code(403).send({ error: host ? `Host ${host} is not allowed` : "Host header is required" });
    }
    const origin = normalizeOrigin(request.headers.origin);
    if (origin && !isAllowed(origin, config.allowedOrigins)) {
      return reply.code(403).send({ error: `Origin ${origin} is not allowed` });
    }
    if (config.apiToken && request.method !== "OPTIONS" && !isAuthorized(request.headers.authorization, config.apiToken)) {
      return reply.code(401).send({ error: "Bearer token required" });
    }
    return undefined;
  });

  void app.register(cors, {
    origin: (origin, callback) => {
      const normalized = normalizeOrigin(origin);
      callback(null, !normalized || isAllowed(normalized, config.allowedOrigins));
    }
  });
  app.addHook("onReady", async () => {
    await durableSessionStore?.migrate();
  });
  app.addHook("onClose", async () => {
    await durableSessionStore?.close();
  });
  registerStreamableMcpRoutes(app, registry, config, () => runtimeSettings.get());

  app.get("/api/health", async (): Promise<ProviderStatus> => {
    const configured = isModelConfigured(config);
    const status: ProviderStatus = {
      provider: config.provider,
      model: config.model,
      configured,
      apiTokenRequired: Boolean(config.apiToken),
      actionLevel: runtimeSettings.get().actionLevel,
      sandboxRoot: config.sandboxRoot,
      durableSessionStore: {
        mode: config.durableSessionMode,
        configured: Boolean(config.databaseUrl)
      },
      capabilities: {
        tools: configured,
        streaming: false,
        toolStreaming: false
      }
    };
    if (config.modelBaseUrl) {
      status.baseUrl = config.modelBaseUrl;
    }
    return status;
  });

  app.get("/api/settings", async (): Promise<RuntimeSettings> => runtimeSettings.get());

  app.post("/api/settings/action-level", async (request, reply): Promise<RuntimeSettings | unknown> => {
    const body = coerceRecord(request.body);
    if (!isAutomationLevel(body.actionLevel)) {
      return reply.code(400).send({ error: "actionLevel must be observe, sandbox, or full-access" });
    }
    return runtimeSettings.setActionLevel(body.actionLevel);
  });

  app.get("/api/tools", async () => ({
    tools: registry.manifests()
  }));

  app.get("/api/skills", async () => ({
    skills: registry.skillPacks()
  }));

  app.get("/api/mcp/tools", async () => ({
    tools: mcpToolSummaries(registry)
  }));

  app.get("/api/mcp/skills", async () => ({
    skills: registry.skillPacks()
  }));

  app.get("/api/approvals", async () => ({
    approvals: await registry.pendingApprovals()
  }));

  app.get("/api/sessions", async (request): Promise<{ sessions: AgentSessionSummary[] }> => {
    const query = request.query as { limit?: string | number } | undefined;
    return {
      sessions: durableSessionStore
        ? await durableSessionStore.listSessions(coerceLimit(query?.limit, 50))
        : []
    };
  });

  app.get("/api/sessions/:id", async (request, reply): Promise<AgentSessionDetail | unknown> => {
    const params = request.params as { id: string };
    const session = await durableSessionStore?.restoreSession(params.id);
    if (!session) {
      return reply.code(404).send({
        error: durableSessionStore
          ? `No durable session found for ${params.id}`
          : "Durable session store is not configured"
      });
    }
    return session;
  });

  app.get("/api/audit/events", async (request) => {
    const query = request.query as { limit?: string | number } | undefined;
    const limit = coerceLimit(query?.limit, 100);
    return {
      events: auditLog.recent(limit)
    };
  });

  app.post("/api/approvals/:id/approve", async (request, reply) => {
    const params = request.params as { id: string };
    const result = await registry.approveToolCall(params.id, currentToolPolicy(config, runtimeSettings.get()));
    if (!result) {
      return reply.code(404).send({ error: `No pending approval found for ${params.id}` });
    }
    await appendApprovalEvents(auditLog, sessionStateStore, result);
    return result;
  });

  app.post("/api/approvals/:id/deny", async (request, reply) => {
    const params = request.params as { id: string };
    const result = await registry.denyToolCall(params.id);
    if (!result) {
      return reply.code(404).send({ error: `No pending approval found for ${params.id}` });
    }
    await appendApprovalEvents(auditLog, sessionStateStore, result);
    return result;
  });

  app.post("/api/mcp/tools/:name/call", async (request) => {
    const params = request.params as { name: string };
    const body = coerceRecord(request.body);
    const args = coerceRecord(body.args ?? body);
    const permissionMode = body.permissionMode === "deny" || body.permissionMode === "ask" || body.permissionMode === "auto"
      ? body.permissionMode
      : "auto";
    const contextInput: Parameters<typeof mcpContext>[0] = {
      permissionMode,
      actionLevel: runtimeSettings.get().actionLevel,
      sandboxRoot: config.sandboxRoot,
      workspaceRoot: config.workspaceRoot
    };
    const context = mcpContext(typeof body.sessionId === "string" && body.sessionId.length > 0
      ? { ...contextInput, sessionId: body.sessionId }
      : contextInput);
    createSecOpsMcpServer(registry, context);
    return registry.executeApiTool(params.name, crypto.randomUUID(), args, context);
  });

  app.post("/api/tools/:id/invoke", async (request) => {
    const params = request.params as { id: string };
    const body = coerceRecord(request.body);
    const context: ToolContext = {
      runId: crypto.randomUUID(),
      permissionMode: "auto",
      actionLevel: runtimeSettings.get().actionLevel,
      sandboxRoot: config.sandboxRoot,
      workspaceRoot: config.workspaceRoot
    };
    return registry.invokeManifest(params.id, body, typeof body.sessionId === "string" && body.sessionId.length > 0
      ? { ...context, sessionId: body.sessionId }
      : context);
  });

  app.post("/api/agent/run", async (request, reply): Promise<unknown> => {
    const body = request.body as Partial<AgentRunRequest> | undefined;
    const runRequest = coerceRunRequest(body);
    if (!runRequest) {
      return reply.code(400).send({ error: "messages must contain at least one user message" });
    }
    const missing = missingModelConfig(config);
    if (missing.length) {
      return reply.code(503).send({ error: `Model provider is not configured. Missing: ${missing.join(", ")}.` });
    }
    const runtime = createRuntime(config, runtimeSettings.get(), registry, runRequest, options, sessionStateStore);
    return runtime.run(runRequest, (event) => auditLog.append(event));
  });

  app.post("/api/agent/events", async (request, reply): Promise<unknown> => {
    const body = request.body as Partial<AgentRunRequest> | undefined;
    const runRequest = coerceRunRequest(body);
    if (!runRequest) {
      return reply.code(400).send({ error: "messages must contain at least one user message" });
    }
    const missing = missingModelConfig(config);
    if (missing.length) {
      return reply.code(503).send({ error: `Model provider is not configured. Missing: ${missing.join(", ")}.` });
    }
    const runtime = createRuntime(config, runtimeSettings.get(), registry, runRequest, options, sessionStateStore);
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive"
    });
    try {
      await runtime.run(runRequest, (event) => {
        auditLog.append(event);
        reply.raw.write(`event: ${event.type}\n`);
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      });
    } catch (error) {
      request.log.error({ err: error }, "Agent event stream failed");
    } finally {
      if (!reply.raw.destroyed && !reply.raw.writableEnded) {
        reply.raw.end();
      }
    }
    return undefined;
  });

  return app;
}

function createRuntime(
  config: AppConfig,
  settings: RuntimeSettings,
  registry: ToolRegistry,
  runRequest: AgentRunRequest,
  options: BuildServerOptions,
  sessionStateStore: SessionStateStore
) {
  return new AgentRuntime({
    model: options.createModel?.(config, runRequest) ?? createAiSdkModel(config),
    registry,
    modelName: config.model,
    providerLabel: config.provider,
    actionLevel: settings.actionLevel,
    sandboxRoot: config.sandboxRoot,
    workspaceRoot: config.workspaceRoot,
    sessionStateStore
  });
}

function currentToolPolicy(config: AppConfig, settings: RuntimeSettings) {
  return {
    actionLevel: settings.actionLevel,
    sandboxRoot: config.sandboxRoot,
    workspaceRoot: config.workspaceRoot
  };
}

function coerceRunRequest(body: Partial<AgentRunRequest> | undefined): AgentRunRequest | undefined {
  if (!body?.messages?.length || !body.messages.some((message) => message.role === "user")) {
    return undefined;
  }
  const runRequest: AgentRunRequest = {
    messages: body.messages,
    permissionMode: coercePermissionMode(body.permissionMode)
  };
  if (typeof body.sessionId === "string" && body.sessionId.length > 0) {
    runRequest.sessionId = body.sessionId;
  }
  if (body.enabledTools) {
    runRequest.enabledTools = body.enabledTools;
  }
  return runRequest;
}

function coercePermissionMode(value: unknown): PermissionMode {
  if (value === "auto" || value === "ask" || value === "deny") {
    return value;
  }
  return value === undefined ? "auto" : "ask";
}

function coerceRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function coerceLimit(value: unknown, fallback: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(Math.trunc(parsed), 1), 200);
}

function isAllowed(value: string, allowed: string[]): boolean {
  return allowed.map((item) => item.toLowerCase()).includes(value.toLowerCase());
}

function isAuthorized(authorization: string | undefined, expectedToken: string): boolean {
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!token) {
    return false;
  }
  const actual = Buffer.from(token);
  const expected = Buffer.from(expectedToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function appendApprovalEvents(auditLog: AuditLog, sessionStateStore: SessionStateStore, result: ApprovalDecisionResult): Promise<void> {
  for (const audit of result.audit) {
    const event = toApprovalRunEvent(result.runId, audit);
    auditLog.append(event);
    if (result.sessionId) {
      await sessionStateStore.recordAuditEvent(result.sessionId, result.runId, audit);
      await sessionStateStore.recordRunEvent(event);
    }
  }
  for (const message of result.messages) {
    const event: AgentRunEvent = {
      id: crypto.randomUUID(),
      runId: result.runId,
      type: "message",
      createdAt: new Date().toISOString(),
      message
    };
    auditLog.append(event);
    if (result.sessionId) {
      await sessionStateStore.appendMessage(result.sessionId, result.runId, message);
      await sessionStateStore.recordRunEvent(event);
    }
  }
  if (result.sessionId) {
    await sessionStateStore.recordToolInvocation(result.sessionId, result.runId, result.invocation, result.artifacts);
  }
}

function toApprovalRunEvent(runId: string, audit: AuditEvent): AgentRunEvent {
  return {
    id: crypto.randomUUID(),
    runId,
    type: "audit",
    createdAt: new Date().toISOString(),
    audit
  };
}

function normalizeOrigin(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) {
    return undefined;
  }
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    return raw.toLowerCase().replace(/\/+$/, "");
  }
}

function normalizeHost(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const lower = value.toLowerCase();
  if (lower.startsWith("[")) {
    const end = lower.indexOf("]");
    return end === -1 ? lower : lower.slice(1, end);
  }
  return lower.split(":")[0];
}
