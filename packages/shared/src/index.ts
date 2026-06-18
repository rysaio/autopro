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

export interface SkillManifest {
  id: string;
  skillPackId: string;
  name: string;
  description: string;
  toolClass: ToolClass;
  risk: ToolRisk;
  defaultPermission: PermissionMode;
  inputSchema: ToolSchema;
  tags: string[];
  mcpCompatible: boolean;
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

export interface AgentRun {
  id: string;
  status: "completed" | "failed" | "needs_approval";
  provider: string;
  model: string;
  startedAt: string;
  completedAt: string;
  messages: ChatMessage[];
  toolInvocations: ToolInvocation[];
  audit: AuditEvent[];
  artifacts: EvidenceArtifact[];
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
  messages: Array<Pick<ChatMessage, "role" | "content">>;
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
  capabilities: {
    tools: boolean;
    streaming: boolean;
    toolStreaming: boolean;
  };
  baseUrl?: string;
}
