export type PermissionMode = "auto" | "ask" | "deny";
export type ToolRisk = "low" | "medium" | "high";
export type ToolClass = "perception" | "reasoning" | "evidence" | "action";
export type AutomationLevel = "observe" | "sandbox" | "full-access";

export interface ToolRoutingHints {
  group?: string;
  keywords?: string[];
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
  routing?: ToolRoutingHints;
}

export interface EvidenceArtifact {
  id: string;
  title: string;
  kind: "ioc" | "detection" | "asset" | "case_note" | "runtime";
  summary: string;
  data: unknown;
  createdAt: string;
}

export interface WazuhExecutionContext {
  runId: string;
  permissionMode: PermissionMode;
  actionLevel: AutomationLevel;
  sandboxRoot?: string;
  workspaceRoot?: string;
  approvedToolCallIds?: string[];
}

export interface WazuhExecutionResult {
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

export interface WazuhPluginTool {
  manifest: ToolManifest;
  apiName: string;
  toModelTool(): ModelTool;
  execute(args: Record<string, unknown>, context: WazuhExecutionContext): Promise<WazuhExecutionResult>;
}
