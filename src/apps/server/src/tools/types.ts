import type {
  AutomationLevel,
  EvidenceArtifact,
  PermissionMode,
  ToolManifest,
  ToolInvocation
} from "@secops-agent/shared";
import type { ModelTool } from "../providers/types.js";

export interface ToolContext {
  runId: string;
  permissionMode: PermissionMode;
  actionLevel: AutomationLevel;
  sandboxRoot: string;
  workspaceRoot: string;
  sessionId?: string;
  approvedToolCallIds?: string[];
  stateMarkers?: string[];
}

export interface ToolExecutionResult {
  output: unknown;
  artifacts?: EvidenceArtifact[];
}

export interface SecOpsTool {
  manifest: ToolManifest;
  apiName: string;
  toModelTool(): ModelTool;
  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult>;
}

export interface ToolExecutionRecord {
  invocation: ToolInvocation;
  artifacts: EvidenceArtifact[];
  metrics: {
    handlerCalled: boolean;
    handlerDurationMs: number;
    evictions: number;
    expiredEntries: number;
    invalidatedEntries: number;
    avoidedToolDurationMs: number;
  };
}

export type ToolTimingScopeFactory = () => () => void;
