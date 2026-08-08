export type MessageRole = "system" | "user" | "assistant" | "tool";

export type PermissionMode = "auto" | "ask" | "deny";

export type ToolRisk = "low" | "medium" | "high";

export type ToolClass = "perception" | "reasoning" | "evidence" | "action";

export type AutomationLevel = "observe" | "sandbox" | "full-access";

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

export interface ToolManifest {
  id: string;
  name: string;
  description: string;
  toolClass: ToolClass;
  risk: ToolRisk;
  /** false=triage 与 deep 均暴露；true=仅在 deep 阶段按需暴露。 */
  deferLoading: boolean;
  inputSchema: ToolSchema;
  tags: string[];
  mcpCompatible: boolean;
}

export type SkillSource = "standalone" | "plugin";

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  source: SkillSource;
  status: "loaded" | "error";
  /** 用户开关：disabled 的技能对模型不可见（从技能提示与 skill_read 中排除），UI 预览不受影响。 */
  enabled: boolean;
  pluginId?: string;
  error?: string;
}

export interface SkillContent extends SkillSummary {
  status: "loaded";
  content: string;
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
  type: "model_request" | "model_response" | "tool_requested" | "tool_result" | "policy_decision";
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
  phase: "triage" | "deep" | "single";
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
  mode: "layered" | "single";
  totalDurationMs: number;
  localRoutingDurationMs: number;
  text: AgentTextMetrics;
  model: AgentModelMetrics;
  tools: {
    callCount: number;
    totalDurationMs: number;
  };
  cache: {
    hits: number;
    misses: number;
    bypasses: number;
    size: number;
  };
  persistence: {
    operationCount: number;
    totalDurationMs: number;
    failureCount: number;
  };
}

export interface AgentRun {
  id: string;
  sessionId?: string;
  status: "completed" | "failed" | "needs_approval";
  provider: string;
  model: string;
  startedAt: string;
  completedAt: string;
  messages: ChatMessage[];
  toolInvocations: ToolInvocation[];
  audit: AuditEvent[];
  artifacts: EvidenceArtifact[];
  metrics: AgentRunMetrics;
}

export interface AgentSessionSummary {
  id: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
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

export interface AgentRunEvent {
  id: string;
  runId: string;
  type: "run_started" | "audit" | "tool" | "artifact" | "message" | "run_completed";
  createdAt: string;
  audit?: AuditEvent;
  invocation?: ToolInvocation;
  artifact?: EvidenceArtifact;
  message?: ChatMessage;
  run?: AgentRun;
}

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
  description: string;
  status: "loaded" | "degraded" | "error";
  toolCount: number;
  skillCount: number;
  mcpServers?: PluginMcpServerSummary[];
  error?: string;
}

export interface PluginMcpServerSummary {
  name: string;
  status: "loaded" | "error";
  toolCount: number;
  transport?: "stdio" | "streamable-http";
  url?: string;
  command?: string;
  args?: string[];
  headerNames?: string[];
  error?: string;
}

export type McpServerTransport = "stdio" | "streamable-http";

export interface McpServerSummary {
  id: string;
  name: string;
  transport: McpServerTransport;
  enabled: boolean;
  status: "connected" | "disabled" | "error";
  toolCount: number;
  envKeys: string[];
  headerNames: string[];
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  error?: string;
  source?: "standalone" | "plugin";
  pluginId?: string;
}

export interface McpServerConfigState {
  servers: McpServerSummary[];
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
