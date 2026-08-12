export type MessageRole = "system" | "user" | "assistant" | "tool";

export type PermissionMode = "auto" | "ask" | "deny";

export type ToolRisk = "low" | "medium" | "high";

export type ToolClass = "perception" | "reasoning" | "evidence" | "action";

export type AutomationLevel = "observe" | "sandbox" | "full-access";

export type AgentRoutingMode = "deterministic" | "layered";

export type ToolGuidanceKind = "precondition" | "missing_context" | "policy" | "validation";

export interface ToolGuidanceNextTool {
  toolName: string;
  reason: string;
  suggestedArgs?: Record<string, unknown>;
}

export interface ToolGuidance {
  kind: ToolGuidanceKind;
  message: string;
  nextTools?: ToolGuidanceNextTool[];
  requiredState?: string[];
  recoverable: boolean;
}

export interface RecoverableToolResult {
  status: "needs_precondition" | "needs_context";
  guidance: ToolGuidance;
}

export interface RuntimeSettings {
  actionLevel: AutomationLevel;
  /** auto 模式下 risk=high 的 action 工具是否仍需审批（默认 true，保守）。 */
  autoApproveHighRisk?: boolean;
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: string;
  name?: string;
  toolCallId?: string;
}

export interface ToolSchema {
  [key: string]: unknown;
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolResultCachePolicy {
  /** Changes whenever the handler or its result contract changes. */
  version: string;
  /** Identity of the backing data source included in the isolation key. */
  dataSource: string;
  ttlMs: number;
  /** Host isolation scope (e.g. `plugin:<pluginId>`); included in the cache key. */
  namespace?: string;
}

export interface SkillManifest {
  id: string;
  skillPackId: string;
  name: string;
  description: string;
  toolClass: ToolClass;
  risk: ToolRisk;
  /** false=triage 与 deep 均暴露；true=仅在 deep 阶段按需暴露。 */
  deferLoading: boolean;
  inputSchema: ToolSchema;
  tags: string[];
  mcpCompatible: boolean;
  /** Missing means disabled. Only explicitly approved read-only tools may opt in. */
  resultCache?: ToolResultCachePolicy;
}

export interface ToolInvocationCacheTrace {
  status: "hit" | "miss" | "bypass";
  reason?: string;
  sourceInvocationId?: string;
  originalCreatedAt?: string;
  ageMs?: number;
  avoidedToolDurationMs?: number;
}

export interface SkillPackManifest {
  id: string;
  name: string;
  description: string;
  version: string;
  tags: string[];
  tools: string[];
  mcpCompatible: boolean;
}

export interface ToolInvocation {
  id: string;
  toolName: string;
  displayName: string;
  status: "approved" | "denied" | "executed" | "failed" | "pending_approval";
  risk: ToolRisk;
  arguments: Record<string, unknown>;
  result?: unknown;
  error?: string;
  guidance?: ToolGuidance;
  cache?: ToolInvocationCacheTrace;
  startedAt: string;
  completedAt?: string;
}

export interface PendingApproval {
  id: string;
  runId: string;
  toolName: string;
  apiName: string;
  displayName: string;
  risk: ToolRisk;
  arguments: Record<string, unknown>;
  requestedAt: string;
  expiresAt: string;
}

export interface ApprovalDecisionResult {
  decision: "approved" | "denied";
  runId: string;
  sessionId?: string;
  invocation: ToolInvocation;
  artifacts: EvidenceArtifact[];
  audit: AuditEvent[];
  messages: ChatMessage[];
}

export interface AuditEvent {
  id: string;
  type: "routing_decision" | "model_request" | "model_response" | "tool_requested" | "tool_result" | "policy_decision";
  label: string;
  detail: string;
  createdAt: string;
  severity: "info" | "warn" | "error";
}

export interface EvidenceArtifact {
  id: string;
  title: string;
  kind: "ioc" | "detection" | "asset" | "case_note" | "runtime";
  summary: string;
  data: unknown;
  createdAt: string;
  cacheSource?: {
    artifactId: string;
    originalCreatedAt: string;
    ageMs: number;
  };
}

export interface AgentModelUsageMetrics {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export interface AgentModelRequestMetrics {
  phase: "triage" | "deep" | "final" | "single";
  durationMs: number;
  exposedToolCount: number;
  outcome: "completed" | "failed";
  finishReason?: string;
  usage: AgentModelUsageMetrics;
}

export type AgentTextMetrics =
  | {
      measurement: "provider-stream";
      timeToFirstTextMs: number;
    }
  | {
      measurement: "unavailable";
    };

export type AgentModelMetrics =
  | {
      measurement: "provider-attempts";
      requestCount: number;
      totalDurationMs: number;
      retryCount: number;
      requests: AgentModelRequestMetrics[];
    }
  | {
      measurement: "unavailable";
      requests: [];
    };

export interface AgentRunMetrics {
  schemaVersion: 1;
  /** Metrics are sealed before the completion snapshot is exported to storage and clients. */
  measurementBoundary: "before-completion-export";
  mode: AgentRoutingMode | "single";
  /** Monotonic elapsed time from run start until the terminal snapshot is fully constructed. */
  totalDurationMs: number;
  /** Total duration excluding the union of provider, tool, and business-persistence wait intervals. */
  localOrchestrationDurationMs: number;
  /** Local subset spent building and applying the current tool-routing decision. */
  localRoutingDurationMs: number;
  text: AgentTextMetrics;
  model: AgentModelMetrics;
  tools: {
    callCount: number;
    handlerCallCount: number;
    totalDurationMs: number;
  };
  cache: {
    hits: number;
    misses: number;
    bypasses: number;
    size: number;
    evictions: number;
    expiredEntries: number;
    invalidatedEntries: number;
    avoidedToolDurationMs: number;
  };
  persistence: {
    operationCount: number;
    /** Business-state writes completed before terminal snapshot export; excludes the export itself. */
    totalDurationMs: number;
    failureCount: number;
    /** 队列等待总时长（enqueue 到开始写入）。 */
    queueWaitDurationMs: number;
    /** 批写入次数与总时长。 */
    batchWriteCount: number;
    batchWriteDurationMs: number;
    /** 观察到的最大队列深度。 */
    maxDepth: number;
    /** 队列饱和（背压等待）次数。 */
    saturationCount: number;
    /** 有界排空耗时；drainTimedOut 为 true 时 remainingOperations 为未完成数量。 */
    drainDurationMs: number;
    drainTimedOut: boolean;
    remainingOperations: number;
  };
  /** 模型客户端生命周期（Issue #9）：本次 run 复用了既有 client 还是新建。 */
  modelClient?: {
    connectionId: string;
    reused: boolean;
  };
  /** Per-model-request context budget breakdown (present when budget tracking is active). */
  contextBudget?: {
    maxInputTokens: number;
    reservedOutputTokens: number;
    requests: Array<{
      phase: string;
      systemPromptTokens: number;
      conversationHistoryTokens: number;
      toolsTokens: number;
      reservedOutputTokens: number;
      totalInputTokens: number;
      withinBudget: boolean;
      summarizedMessages: number;
      droppedMessages: number;
    }>;
  };
}

export interface AgentRoutingDecision {
  mode: AgentRoutingMode;
  selectedToolIds: string[];
  groups: string[];
  confidence: {
    level: "high" | "medium" | "low";
    score: number;
  };
  reasons: string[];
  additionalModelStage: {
    used: boolean;
    reason: string;
  };
}

export type AgentRunStatus = "completed" | "failed" | "needs_approval" | "cancelled" | "timed_out";

export interface AgentRun {
  id: string;
  sessionId?: string;
  status: AgentRunStatus;
  terminalReason: string;
  provider: string;
  model: string;
  startedAt: string;
  completedAt: string;
  messages: ChatMessage[];
  toolInvocations: ToolInvocation[];
  audit: AuditEvent[];
  artifacts: EvidenceArtifact[];
  routing: AgentRoutingDecision;
  metrics: AgentRunMetrics;
}

export interface AgentSessionSummary {
  id: string;
  createdAt: string;
  updatedAt: string;
  runCount: number;
  messageCount: number;
  toolInvocationCount: number;
  guidanceCount: number;
  pendingApprovalCount: number;
  latestMessage?: ChatMessage;
}

export interface AgentSessionDetail extends AgentSessionSummary {
  runs: AgentRun[];
  messages: ChatMessage[];
  toolInvocations: ToolInvocation[];
  artifacts: EvidenceArtifact[];
  guidance: ToolGuidance[];
  audit: AuditEvent[];
  stateMarkers: Array<{
    id: string;
    sessionId: string;
    runId: string;
    key: string;
    value: unknown;
    createdAt: string;
  }>;
}

export interface AgentRunEventBase {
  id: string;
  runId: string;
  createdAt: string;
}

export type AgentRunEventPayload =
  | { type: "run_started" }
  | { type: "text_delta"; messageId: string; delta: string }
  | { type: "audit"; audit: AuditEvent }
  | { type: "tool"; invocation: ToolInvocation }
  | { type: "artifact"; artifact: EvidenceArtifact }
  | { type: "message"; message: ChatMessage }
  | { type: "run_completed"; run: AgentRun };

export type AgentRunEvent = AgentRunEventBase & AgentRunEventPayload;

export interface AgentRunRequest {
  /** 消息需携带原始 id（如有），服务端持久化按 id 去重，避免历史消息重复入库。 */
  messages: Array<Pick<ChatMessage, "role" | "content"> & {
    id?: string;
    createdAt?: string;
    name?: string;
    toolCallId?: string;
  }>;
  sessionId?: string;
  enabledTools?: string[];
  permissionMode?: PermissionMode;
}

export interface ProviderStatus {
  provider: string;
  model: string;
  configured: boolean;
  apiTokenRequired: boolean;
  actionLevel: AutomationLevel;
  sandboxRoot: string;
  durableSessionStore: {
    mode: "postgres" | "disabled";
    configured: boolean;
  };
  capabilities: {
    tools: boolean;
    streaming: boolean;
    toolStreaming: boolean;
  };
  baseUrl?: string;
  /** 模型客户端生命周期指标（Issue #9）：创建/复用/失效/失败独立于模型请求时长。 */
  modelClients?: ModelClientLifecycleMetrics;
}

/** 模型客户端生命周期指标：仅含稳定非机密连接标识符，永不包含 API key 或授权头。 */
export interface ModelClientLifecycleMetrics {
  connections: Array<{
    connectionId: string;
    created: number;
    reused: number;
    invalidated: number;
    creationFailures: number;
    disposed: number;
    active: number;
  }>;
  totalCreated: number;
  totalReused: number;
  totalInvalidated: number;
  totalCreationFailures: number;
  totalDisposed: number;
}

/** 对外暴露的模型连接摘要：永不携带明文 apiKey。 */
export interface ModelConnectionSummary {
  id: string;
  name: string;
  provider: string;
  model: string;
  baseUrl: string;
  apiKeySet: boolean;
}

export interface ModelConfigState {
  connections: ModelConnectionSummary[];
  activeConnectionId: string | null;
}

export interface PluginSummary {
  id: string;
  name: string;
  version: string;
  status: "loaded" | "error";
  toolCount: number;
  error?: string;
}

/** AgentEnvironment 基座聚合状态：模型连接 + 插件外围设施 + 运行时设置。 */
export interface EnvironmentStatus {
  model: {
    configured: boolean;
    provider: string;
    model: string;
    baseUrl?: string;
    connections: number;
    activeConnectionId: string | null;
  };
  plugins: {
    installed: number;
    loaded: number;
    failed: number;
    plugins: PluginSummary[];
  };
  settings: RuntimeSettings;
}
