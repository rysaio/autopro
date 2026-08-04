import type { RecoverableToolResult, ToolGuidance } from "@secops-agent/shared";

export function needsPrecondition(guidance: ToolGuidance): RecoverableToolResult {
  return {
    status: "needs_precondition",
    guidance
  };
}

export function needsContext(guidance: ToolGuidance): RecoverableToolResult {
  return {
    status: "needs_context",
    guidance
  };
}

export function isRecoverableToolResult(value: unknown): value is RecoverableToolResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as { status?: unknown; guidance?: unknown };
  return (
    (candidate.status === "needs_precondition" || candidate.status === "needs_context") &&
    isToolGuidance(candidate.guidance)
  );
}

function isToolGuidance(value: unknown): value is ToolGuidance {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<ToolGuidance>;
  return (
    (candidate.kind === "precondition" ||
      candidate.kind === "missing_context" ||
      candidate.kind === "policy" ||
      candidate.kind === "validation") &&
    typeof candidate.message === "string" &&
    typeof candidate.recoverable === "boolean"
  );
}
