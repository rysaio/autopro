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
  manifest: SkillManifest;
  apiName: string;
  toModelTool(): ModelTool;
  execute(args: Record<string, unknown>, context: WazuhExecutionContext): Promise<WazuhExecutionResult>;
}
