import cors from "@fastify/cors";
import Fastify from "fastify";
import { timingSafeEqual } from "node:crypto";
import type { LanguageModel } from "ai";
import type {
  AgentRunEvent,
  AgentRunRequest,
  AgentRoutingMode,
  AgentSessionDetail,
  AgentSessionSummary,
  ApprovalDecisionResult,
  AuditEvent,
  EnvironmentStatus,
  ModelConfigState,
  PermissionMode,
  PluginSummary,
  ProviderStatus,
  RuntimeSettings
} from "@secops-agent/shared";
import type { AppConfig } from "./config.js";
import { createAiSdkModel } from "./providers/aiSdkModelFactory.js";
import { AgentEnvironment } from "./runtime/agentEnvironment.js";
import { ModelConfigStore, type ModelConnection } from "./runtime/modelConfigStore.js";
import { PluginManager, type PluginManagerOptions, type ResolvedMcpServer, type McpClientHandle } from "./plugins/pluginManager.js";
import { AgentRuntime, type AgentRunAbortReason } from "./runtime/agentRuntime.js";
import { AuditLog } from "./runtime/auditLog.js";
import { ApprovalStore } from "./runtime/approvalStore.js";
import { PostgresSessionStore } from "./runtime/postgresSessionStore.js";
import { isAutomationLevel, RuntimeSettingsStore } from "./runtime/runtimeSettings.js";
import { NoopSessionStateStore, type SessionStateStore } from "./runtime/sessionStateStore.js";
import { ToolVisibilityStore } from "./runtime/toolVisibilityStore.js";
import { createSecOpsMcpServer, mcpContext, mcpToolSummaries } from "./mcp/secopsMcpServer.js";
import { registerStreamableMcpRoutes } from "./mcp/streamableHttp.js";
import { ToolRegistry } from "./tools/registry.js";
import type { ToolContext } from "./tools/types.js";

export interface BuildServerOptions {
  createModel?: (connection: ModelConnection, request: AgentRunRequest) => LanguageModel;
  /** 测试注入：自定义插件 MCP 客户端工厂（默认为真实 stdio 连接）。 */
  createPluginClient?: PluginManagerOptions["createClient"];
  /** @deprecated Use agentRoutingMode. true selects the temporary layered rollback mode. */
  enableLayeredRouting?: boolean;
  agentRoutingMode?: AgentRoutingMode;
}

export function buildServer(config: AppConfig, options: BuildServerOptions = {}) {
  const app = Fastify({ logger: true });
  const durableSessionStore = config.durableSessionMode === "postgres"
    ? new PostgresSessionStore(config.dataDir)
    : undefined;
  const sessionStateStore: SessionStateStore = durableSessionStore ?? new NoopSessionStateStore();
  const registry = new ToolRegistry(undefined, durableSessionStore ?? new ApprovalStore(config.approvalStorePath));
  const auditLog = new AuditLog(config.auditLogPath);
  const runtimeSettings = new RuntimeSettingsStore(config.runtimeConfigPath, {
    actionLevel: config.actionLevel,
    autoApproveHighRisk: true
  });
  // 运行时开关同步到 ToolRegistry（auto 模式下高危 action 是否仍审批）
  registry.setAutoApproveHighRisk(runtimeSettings.get().autoApproveHighRisk ?? true);
  const modelConfigStore = new ModelConfigStore(config.modelConfigPath);
  const toolVisibilityStore = new ToolVisibilityStore(config.toolVisibilityPath);
  const pluginManager = new PluginManager({
    pluginsDir: config.pluginsDir,
    registry,
    ...(options.createPluginClient ? { createClient: options.createPluginClient } : {})
  });
  // AgentEnvironment 基座：统一管理配置（settings/models）与外围设施（plugins）
  const environment = new AgentEnvironment(runtimeSettings, modelConfigStore, pluginManager);
  const activeRuns = new Map<string, AbortController>();

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
    // 启动时按基座顺序加载：settings/models 构造即加载，插件扫描加载；单插件失败不影响启动
    await environment.loadAll();
    applyToolVisibilityOverrides(registry, toolVisibilityStore);
  });
  app.addHook("onClose", async () => {
    await pluginManager.disconnectAll();
    await durableSessionStore?.close();
  });
  registerStreamableMcpRoutes(app, registry, config, () => runtimeSettings.get());

  app.get("/api/health", async (): Promise<ProviderStatus> => {
    const modelStatus = environment.status().model;
    const status: ProviderStatus = {
      provider: modelStatus.provider,
      model: modelStatus.model,
      configured: modelStatus.configured,
      apiTokenRequired: Boolean(config.apiToken),
      actionLevel: runtimeSettings.get().actionLevel,
      sandboxRoot: config.sandboxRoot,
      durableSessionStore: {
        mode: config.durableSessionMode,
        configured: config.durableSessionMode === "postgres"
      },
      capabilities: {
        tools: modelStatus.configured,
        streaming: modelStatus.configured,
        toolStreaming: modelStatus.configured
      }
    };
    if (modelStatus.baseUrl) {
      status.baseUrl = modelStatus.baseUrl;
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

  app.get("/api/settings/auto-approve-high-risk", async () => ({
    autoApproveHighRisk: runtimeSettings.get().autoApproveHighRisk ?? true
  }));

  app.put("/api/settings/auto-approve-high-risk", async (request, reply) => {
    const body = coerceRecord(request.body);
    if (typeof body.autoApproveHighRisk !== "boolean") {
      return reply.code(400).send({ error: "autoApproveHighRisk must be a boolean" });
    }
    const settings = runtimeSettings.setAutoApproveHighRisk(body.autoApproveHighRisk);
    registry.setAutoApproveHighRisk(settings.autoApproveHighRisk ?? true);
    return { autoApproveHighRisk: settings.autoApproveHighRisk ?? true };
  });

  // ── AgentEnvironment 基座聚合视图：模型连接 + 插件外围设施 + 运行时设置 ──
  app.get("/api/environment", async (): Promise<EnvironmentStatus> => environment.status());

  // ── 模型连接热配置 API：启动后可增删改/切换，写文件即生效，无需重启 ──
  app.get("/api/model-config", async (): Promise<ModelConfigState> => modelConfigStore.list());

  app.post("/api/model-config", async (request, reply): Promise<ModelConfigState | unknown> => {
    const body = coerceRecord(request.body);
    try {
      modelConfigStore.add({
        name: stringField(body.name),
        provider: stringField(body.provider),
        model: stringField(body.model),
        baseUrl: stringField(body.baseUrl),
        apiKey: typeof body.apiKey === "string" ? body.apiKey : ""
      });
      return modelConfigStore.list();
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.put("/api/model-config/:id", async (request, reply): Promise<ModelConfigState | unknown> => {
    const params = request.params as { id: string };
    const body = coerceRecord(request.body);
    try {
      const updated = modelConfigStore.update(params.id, {
        ...(typeof body.name === "string" ? { name: body.name } : {}),
        ...(typeof body.provider === "string" ? { provider: body.provider } : {}),
        ...(typeof body.model === "string" ? { model: body.model } : {}),
        ...(typeof body.baseUrl === "string" ? { baseUrl: body.baseUrl } : {}),
        ...(body.apiKey !== undefined ? { apiKey: typeof body.apiKey === "string" ? body.apiKey : "" } : {})
      });
      if (!updated) {
        return reply.code(404).send({ error: `No model connection found for ${params.id}` });
      }
      return modelConfigStore.list();
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete("/api/model-config/:id", async (request, reply): Promise<ModelConfigState | unknown> => {
    const params = request.params as { id: string };
    if (!modelConfigStore.remove(params.id)) {
      return reply.code(404).send({ error: `No model connection found for ${params.id}` });
    }
    return modelConfigStore.list();
  });

  app.post("/api/model-config/:id/activate", async (request, reply): Promise<ModelConfigState | unknown> => {
    const params = request.params as { id: string };
    const activated = modelConfigStore.setActive(params.id);
    if (!activated) {
      return reply.code(404).send({ error: `No model connection found for ${params.id}` });
    }
    return modelConfigStore.list();
  });

  // 从文件重新加载 model.json（启动后直接编辑文件时的显式重载入口；
  // 后续前端配置界面的"重载"按钮调用同一端点）
  app.post("/api/model-config/reload", async (): Promise<ModelConfigState> => modelConfigStore.reload());

  app.get("/api/tools", async () => ({
    tools: registry.manifests()
  }));

  app.get("/api/tools/visibility", async () => ({
    visibility: toolVisibilityStore.get()
  }));

  app.put("/api/tools/visibility/:id", async (request, reply) => {
    const params = request.params as { id: string };
    const body = coerceRecord(request.body);
    if (typeof body.deferLoading !== "boolean") {
      return reply.code(400).send({ error: "deferLoading must be a boolean" });
    }
    if (!hasManifest(registry, params.id)) {
      return reply.code(404).send({ error: `No tool found for ${params.id}` });
    }
    toolVisibilityStore.set(params.id, body.deferLoading);
    registry.setDeferLoadingOverride(params.id, body.deferLoading);
    return { visibility: toolVisibilityStore.get() };
  });

  app.delete("/api/tools/visibility/:id", async (request, reply) => {
    const params = request.params as { id: string };
    if (!hasManifest(registry, params.id) || !toolVisibilityStore.clear(params.id)) {
      return reply.code(404).send({ error: `No tool visibility override found for ${params.id}` });
    }
    registry.clearDeferLoadingOverride(params.id);
    return { visibility: toolVisibilityStore.get() };
  });

  app.get("/api/skills", async () => ({
    skills: registry.skillPacks()
  }));

  // ── 插件热插拔 API：安装插件目录到 runtime/plugins/ 后 reload 一次即可 reach ──
  app.get("/api/plugins", async (): Promise<{ plugins: PluginSummary[] }> => ({
    plugins: pluginManager.status()
  }));

  app.post("/api/plugins/reload", async (): Promise<{ plugins: PluginSummary[] }> => {
    await pluginManager.reload();
    applyToolVisibilityOverrides(registry, toolVisibilityStore);
    return { plugins: pluginManager.status() };
  });

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
    const connection = modelConfigStore.resolveConnection();
    if (!connection) {
      return reply.code(503).send({ error: "Model provider is not configured. Configure a model connection first." });
    }
    const runtime = createRuntime(config, runtimeSettings.get(), registry, runRequest, options, sessionStateStore, connection);
    return runtime.run(runRequest, (event) => auditLog.append(event));
  });

  
  app.post("/api/reports/generate", async (request, reply) => {
    const body = coerceRecord(request.body);
    const context: ToolContext = {
      runId: crypto.randomUUID(),
      permissionMode: "auto",
      actionLevel: runtimeSettings.get().actionLevel,
      sandboxRoot: config.sandboxRoot,
      workspaceRoot: config.workspaceRoot
    };
    const toolContext = typeof body.sessionId === "string" && body.sessionId.length > 0
      ? { ...context, sessionId: body.sessionId }
      : context;
    try {
      const result = await registry.invokeManifest("report.generate", {
        sessionId: body.sessionId ?? "",
        reportTitle: body.reportTitle ?? "Untitled Report",
        severity: body.severity ?? "medium",
        toolInvocations: body.toolInvocations ?? [],
        artifacts: body.artifacts ?? [],
        messages: body.messages ?? []
      }, toolContext);
      return result;
    } catch (error) {
      return reply.code(500).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/reports/export", async (request, reply) => {
    const body = coerceRecord(request.body);
    try {
      const result = await registry.invokeManifest("report.export", {
        sessionId: body.sessionId ?? "",
        format: body.format ?? "markdown",
        reportData: body.reportData ?? {}
      }, {
        runId: crypto.randomUUID(),
        permissionMode: "auto",
        actionLevel: runtimeSettings.get().actionLevel,
        sandboxRoot: config.sandboxRoot,
        workspaceRoot: config.workspaceRoot
      });
      return result;
    } catch (error) {
      return reply.code(500).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/agent/runs/:runId/cancel", async (request, reply): Promise<unknown> => {
    const runId = stringField((request.params as { runId?: unknown }).runId);
    const controller = activeRuns.get(runId);
    if (!controller) {
      return reply.code(404).send({ error: `Active run ${runId} was not found.` });
    }
    const requestedReason = stringField(coerceRecord(request.body).reason);
    const reason: AgentRunAbortReason = requestedReason === "timed_out"
      ? { status: "timed_out", message: "The client stream deadline elapsed." }
      : { status: "cancelled", message: "The analyst cancelled the active run." };
    controller.abort(reason);
    return { runId, status: reason.status };
  });

  app.post("/api/agent/events", async (request, reply): Promise<unknown> => {
    const body = request.body as Partial<AgentRunRequest> | undefined;
    const runRequest = coerceRunRequest(body);
    if (!runRequest) {
      return reply.code(400).send({ error: "messages must contain at least one user message" });
    }
    const connection = modelConfigStore.resolveConnection();
    if (!connection) {
      return reply.code(503).send({ error: "Model provider is not configured. Configure a model connection first." });
    }
    const runtime = createRuntime(config, runtimeSettings.get(), registry, runRequest, options, sessionStateStore, connection);
    const controller = new AbortController();
    let activeRunId: string | undefined;
    const abortForDisconnect = () => {
      if (!reply.raw.writableEnded && !controller.signal.aborted) {
        controller.abort({
          status: "cancelled",
          message: "The SSE client disconnected before the run completed."
        } satisfies AgentRunAbortReason);
      }
    };
    request.raw.once("aborted", abortForDisconnect);
    reply.raw.once("close", abortForDisconnect);
    const requestOrigin = normalizeOrigin(request.headers.origin);
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      ...(requestOrigin && isAllowed(requestOrigin, config.allowedOrigins)
        ? { "access-control-allow-origin": requestOrigin, vary: "Origin" }
        : {})
    });
    try {
      await runtime.run(runRequest, (event) => {
        if (event.type === "run_started") {
          activeRunId = event.runId;
          activeRuns.set(event.runId, controller);
        }
        if (event.type !== "text_delta") {
          auditLog.append(event);
        }
        if (!reply.raw.destroyed && !reply.raw.writableEnded) {
          reply.raw.write(`event: ${event.type}\n`);
          reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
        }
      }, { signal: controller.signal });
    } catch (error) {
      request.log.error({ err: error }, "Agent event stream failed");
    } finally {
      request.raw.off("aborted", abortForDisconnect);
      reply.raw.off("close", abortForDisconnect);
      if (activeRunId) {
        activeRuns.delete(activeRunId);
      }
      if (!reply.raw.destroyed && !reply.raw.writableEnded) {
        reply.raw.end();
      }
    }
    return undefined;
  });

  return app;
}

function applyToolVisibilityOverrides(registry: ToolRegistry, store: ToolVisibilityStore): void {
  for (const [id, deferLoading] of Object.entries(store.get())) {
    registry.setDeferLoadingOverride(id, deferLoading);
  }
}

function hasManifest(registry: ToolRegistry, id: string): boolean {
  return registry.manifests().some((manifest) => manifest.id === id);
}

function createRuntime(
  config: AppConfig,
  settings: RuntimeSettings,
  registry: ToolRegistry,
  runRequest: AgentRunRequest,
  options: BuildServerOptions,
  sessionStateStore: SessionStateStore,
  connection: ModelConnection
) {
  return new AgentRuntime({
    model: options.createModel?.(connection, runRequest) ?? createAiSdkModel(connection),
    registry,
    modelName: connection.model,
    providerLabel: connection.provider,
    actionLevel: settings.actionLevel,
    sandboxRoot: config.sandboxRoot,
    workspaceRoot: config.workspaceRoot,
    sessionStateStore,
    runTimeoutMs: config.agentRunTimeoutMs,
    agentRoutingMode: options.agentRoutingMode
      ?? (options.enableLayeredRouting === undefined
        ? config.agentRoutingMode
        : options.enableLayeredRouting ? "layered" : "deterministic")
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

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
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
