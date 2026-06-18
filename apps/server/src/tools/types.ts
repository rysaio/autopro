import type {
  AutomationLevel,
  EvidenceArtifact,
  PermissionMode,
  SkillManifest,
  ToolInvocation
} from "@secops-agent/shared";
import type { ModelTool } from "../providers/types.js";

export interface ToolContext {
  runId: string;
  permissionMode: PermissionMode;
  actionLevel: AutomationLevel;
  sandboxRoot: string;
  workspaceRoot: string;
  approvedToolCallIds?: string[];
  stateMarkers?: string[];
}

export interface ToolExecutionResult {
  output: unknown;
  artifacts?: EvidenceArtifact[];
}

export interface SecOpsTool {
  manifest: SkillManifest;
  apiName: string;
  toModelTool(): ModelTool;
  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult>;
}

export interface ToolExecutionRecord {
  invocation: ToolInvocation;
  artifacts: EvidenceArtifact[];
}
