import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import type { ChatMessage, ToolGuidance, ToolInvocation, ToolManifest } from "@secops-agent/shared";
import { clampSidebarWidth, conversationTitle, reconcileEnabledTools, ToolCallCard } from "../src/App.js";
import { McpServerConfigView } from "../src/McpServerConfigView.js";
import { PluginView } from "../src/PluginView.js";
import { SkillView } from "../src/SkillView.js";

const now = new Date("2026-06-19T00:00:00.000Z").toISOString();

const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
if (!/@media \(max-width: 1240px\)\s*{\s*\.app-shell\s*{\s*grid-template-columns:\s*var\(--sidebar-width, 176px\) 10px minmax\(0, 1fr\)/.test(styles)) {
  throw new Error("Expected the compact desktop layout to keep a resizable sidebar, divider, and chat in three columns.");
}

for (const [requested, expected] of [[176, 176], [150, 176], [120, 0], [0, 0]] as const) {
  if (clampSidebarWidth(requested) !== expected) {
    throw new Error(`Expected sidebar width ${requested} to resolve to ${expected}.`);
  }
}

const longTitleMessage: ChatMessage = {
  id: "message-title",
  role: "user",
  content: "12345678901234567890标题后的内容",
  createdAt: now
};
if (conversationTitle([longTitleMessage]) !== "12345678901234567890…") {
  throw new Error("Expected conversation titles to truncate after 20 characters.");
}

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

const mcpConfigHtml = renderToStaticMarkup(
  <McpServerConfigView
    onChanged={() => undefined}
    state={{
      servers: [{
        id: "remote-mcp",
        name: "Remote MCP",
        transport: "streamable-http",
        enabled: true,
        status: "connected",
        toolCount: 3,
        envKeys: [],
        headerNames: ["Authorization"],
        url: "https://mcp.example.test/api"
      }]
    }}
  />
);
for (const expected of ["Remote MCP", "已连接", "Authorization", "添加服务", "从文件重载"]) {
  if (!mcpConfigHtml.includes(escapeHtml(expected))) {
    throw new Error(`Expected MCP config markup to contain ${expected}.\n${mcpConfigHtml}`);
  }
}

const pluginHtml = renderToStaticMarkup(
  <PluginView
    enabledTools={new Set(["wazuh.alerts.search"])}
    fullAccessActive={false}
    onReload={async () => []}
    onTogglePlugin={() => undefined}
    onToggleTool={() => undefined}
    plugins={[{
      id: "wazuh",
      name: "Wazuh",
      version: "1.0.0",
      description: "Wazuh plugin.",
      status: "loaded",
      toolCount: 4,
      skillCount: 3,
      mcpServers: [{ name: "wazuh", status: "loaded", toolCount: 4 }]
    }]}
    tools={[toolManifest("wazuh.alerts.search", "medium", ["plugin", "wazuh"])]}
  />
);
for (const expected of ["插件目录", "重新加载插件", "Wazuh", "3 技能", "4 工具", "启用插件 Wazuh 的全部工具"]) {
  if (!pluginHtml.includes(escapeHtml(expected))) {
    throw new Error(`Expected plugin markup to contain ${expected}.\n${pluginHtml}`);
  }
}

const skillHtml = renderToStaticMarkup(
  <SkillView
    onReload={async () => []}
    onToggleSkill={() => undefined}
    skills={[{
      id: "case-review",
      name: "case-review",
      description: "Review a case.",
      source: "standalone",
      status: "loaded",
      enabled: true
    }]}
  />
);
for (const expected of ["技能目录", "重新加载技能", "case-review", "独立技能", "启用技能 case-review"]) {
  if (!skillHtml.includes(escapeHtml(expected))) {
    throw new Error(`Expected skill markup to contain ${expected}.\n${skillHtml}`);
  }
}
for (const markup of [pluginHtml, skillHtml, mcpConfigHtml]) {
  for (const removedTerm of ["能力", "工具包"]) {
    if (markup.includes(removedTerm)) {
      throw new Error(`Expected workspace markup not to contain ${removedTerm}.\n${markup}`);
    }
  }
}

const previousTools = [toolManifest("kept", "medium"), toolManifest("removed", "low")];
const nextTools = [
  toolManifest("kept", "medium"),
  toolManifest("new-default", "low"),
  toolManifest("new-high-risk", "high")
];
const reconciled = reconcileEnabledTools(new Set(["kept", "removed"]), previousTools, nextTools);
for (const expected of ["kept", "new-default"]) {
  if (!reconciled.has(expected)) {
    throw new Error(`Expected refreshed tool selection to include ${expected}.`);
  }
}
for (const unexpected of ["removed", "new-high-risk"]) {
  if (reconciled.has(unexpected)) {
    throw new Error(`Expected refreshed tool selection to exclude ${unexpected}.`);
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

function toolManifest(id: string, risk: ToolManifest["risk"], tags: string[] = []): ToolManifest {
  return {
    id,
    name: id,
    description: `${id} description`,
    toolClass: "perception",
    risk,
    deferLoading: false,
    tags,
    mcpCompatible: true,
    inputSchema: { type: "object", properties: {} }
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}
