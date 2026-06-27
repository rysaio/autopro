import { renderToStaticMarkup } from "react-dom/server";
import type { ToolGuidance, ToolInvocation } from "@secops-agent/shared";
import { ToolCallCard } from "../src/App.js";

const now = new Date("2026-06-19T00:00:00.000Z").toISOString();

const guidance: ToolGuidance = {
  kind: "precondition",
  message: "Call shuffle.workflow.get before shuffle.workflow.execute.",
  nextTools: [
    {
      toolName: "shuffle.workflow.get",
      reason: "Fetch workflow metadata before execution.",
      suggestedArgs: { workflowId: "wf-1" }
    }
  ],
  requiredState: ["shuffle.workflow.metadata:wf-1"],
  recoverable: true
};

const cases: Array<{ name: string; invocation: ToolInvocation; expected: string[] }> = [
  {
    name: "guidance",
    invocation: invocation({
      id: "tool-guidance",
      status: "failed",
      result: { status: "needs_precondition", guidance },
      guidance
    }),
    expected: [
      "guidance",
      "Call shuffle.workflow.get before shuffle.workflow.execute.",
      "shuffle.workflow.get",
      "shuffle.workflow.metadata:wf-1"
    ]
  },
  {
    name: "denied",
    invocation: invocation({
      id: "tool-denied",
      status: "denied",
      error: "Action tools are denied in observe mode."
    }),
    expected: ["denied", "Action tools are denied in observe mode."]
  },
  {
    name: "hard failure",
    invocation: invocation({
      id: "tool-failed",
      status: "failed",
      error: "caseId is required."
    }),
    expected: ["failed", "caseId is required."]
  },
  {
    name: "pending approval",
    invocation: invocation({
      id: "tool-pending",
      status: "pending_approval",
      error: "Action tool requires explicit analyst approval"
    }),
    expected: ["pending_approval", "Allow", "Deny"]
  }
];

for (const testCase of cases) {
  const html = renderToStaticMarkup(
    <ToolCallCard
      invocation={testCase.invocation}
      isResolving={false}
      onApprove={() => undefined}
      onDeny={() => undefined}
    />
  );
  for (const expected of testCase.expected) {
    if (!html.includes(escapeHtml(expected))) {
      throw new Error(`Expected ${testCase.name} markup to contain ${expected}.\n${html}`);
    }
  }
}

function invocation(input: Partial<ToolInvocation> & Pick<ToolInvocation, "id" | "status">): ToolInvocation {
  const record: ToolInvocation = {
    id: input.id,
    toolName: input.toolName ?? "case.note.write",
    displayName: input.displayName ?? "Write Case Note",
    status: input.status,
    risk: input.risk ?? "medium",
    arguments: input.arguments ?? { caseId: "INC-123" },
    startedAt: input.startedAt ?? now,
    completedAt: input.completedAt ?? now
  };
  if ("result" in input) {
    record.result = input.result;
  }
  if (input.error) {
    record.error = input.error;
  }
  if (input.guidance) {
    record.guidance = input.guidance;
  }
  return record;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

