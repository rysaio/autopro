export type PermissionMode = "auto" | "ask" | "deny";
export type ToolRisk = "low" | "medium" | "high";
export type ToolClass = "perception" | "reasoning" | "evidence" | "action";
export type AutomationLevel = "observe" | "sandbox" | "full-access";

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

export interface EvidenceArtifact {
  id: string;
  title: string;
  kind: "ioc" | "detection" | "asset" | "case_note" | "runtime";
  summary: string;
  data: unknown;
  createdAt: string;
}

export interface ShuffleExecutionContext {
  runId: string;
  permissionMode: PermissionMode;
  actionLevel: AutomationLevel;
  sandboxRoot?: string;
  workspaceRoot?: string;
  approvedToolCallIds?: string[];
  stateMarkers?: string[];
}

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

export interface ShuffleExecutionResult {
  output: unknown;
  artifacts?: EvidenceArtifact[];
}

export interface ModelTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: ToolSchema;
  };
}

export interface ShufflePluginTool {
  manifest: SkillManifest;
  apiName: string;
  toModelTool(): ModelTool;
  execute(args: Record<string, unknown>, context: ShuffleExecutionContext): Promise<ShuffleExecutionResult>;
}
