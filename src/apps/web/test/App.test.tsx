import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import type { ChatMessage, ToolGuidance, ToolInvocation, ToolManifest } from "@secops-agent/shared";
import { clampSidebarWidth, conversationTitle, mergeInvocations, reconcileEnabledTools, ToolCallCard } from "../src/App.js";
import { McpServerConfigView } from "../src/McpServerConfigView.js";
import { PluginView } from "../src/PluginView.js";
import { SkillView } from "../src/SkillView.js";
import {
  buildKnowledgeGraphData,
  KNOWLEDGE_GRAPH_EDGE_STYLE,
  KNOWLEDGE_GRAPH_NODE_STYLE,
  type KnowledgeGraphProps
} from "../src/KnowledgeGraphView.js";

const now = new Date("2026-06-19T00:00:00.000Z").toISOString();

const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
if (!/@media \(max-width: 1240px\)\s*{\s*\.app-shell\s*{\s*grid-template-columns:\s*var\(--sidebar-width, 176px\) 10px minmax\(0, 1fr\)/.test(styles)) {
  throw new Error("Expected the compact desktop layout to keep a resizable sidebar, divider, and chat in three columns.");
}

for (const [foreground, background, minimum] of [
  ["text-primary", "surface-primary", 7],
  ["text-secondary", "surface-primary", 7],
  ["text-tertiary", "surface-primary", 4.5],
  ["focus-ring", "surface-primary", 3]
] as const) {
  const ratio = contrastRatio(cssHexToken(styles, foreground), cssHexToken(styles, background));
  if (ratio < minimum) {
    throw new Error(`Expected --${foreground} on --${background} to reach ${minimum}:1 contrast, received ${ratio.toFixed(2)}:1.`);
  }
}

const passiveControlContrast = contrastRatio(cssHexToken(styles, "border-control"), cssHexToken(styles, "surface-primary"));
const focusedControlContrast = contrastRatio(cssHexToken(styles, "focus-ring"), cssHexToken(styles, "surface-primary"));
if (passiveControlContrast >= focusedControlContrast) {
  throw new Error("Expected resting input borders to be lighter than the focused input border.");
}
if (!/textarea:focus-visible,[\s\S]*input:focus-visible,[\s\S]*select:focus-visible\s*{[\s\S]*outline:\s*none;[\s\S]*box-shadow:\s*0 0 0 2px var\(--focus-halo\)/.test(styles)) {
  throw new Error("Expected inputs to use a soft focus halo instead of a thick dark outline.");
}
if (!/\.tool-call-section \.collapsible-json-toggle\s*{[^}]*display:\s*inline-flex/.test(styles)) {
  throw new Error("Expected tool call payload/result toggles to remain visible so analysts can expand details.");
}
if (!/\.message\.assistant\.thinking \+ \.tool-call\s*{[^}]*margin-top:\s*-14px/.test(styles)) {
  throw new Error("Expected the transcript spacing between a thinking card and an immediately following tool call card to be tightened.");
}
if (!/\.approval-panel\s*{[^}]*display:\s*grid/.test(styles)) {
  throw new Error("Expected approval panel to remain displayed as a grid.");
}
if (!/\.approval-actions\s*{[^}]*display:\s*flex/.test(styles)) {
  throw new Error("Expected approval actions to remain displayed as a flex row.");
}
if (!/\.model-config-row\.active\s*{[^}]*background:\s*var\(--surface-raised\)/.test(styles)) {
  throw new Error("Expected the active model configuration row to use a raised white surface.");
}

const toolBlueSelectors = [
  ".tool-filters button.active",
  ".config-workspace .tool-filters button.active",
  ".tool-workspace-tabs button.active",
  ".tool-workspace-tabs button strong",
  ".dashboard-stat .stat-icon-chat",
  ".section-label svg.stat-icon-report"
];
for (const block of styles.split("}")) {
  if (!block.includes("var(--tool-selected-") || block.includes(":root")) continue;
  if (!toolBlueSelectors.some((selector) => block.includes(selector))) {
    throw new Error(`Expected Tool blue to stay inside its interaction whitelist.\n${block.trim()}`);
  }
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
    expected: ["pending_approval", "Allow", "Deny", "approval-panel", "approval-actions"]
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

const firstInvocation = invocation({ id: "tool-old", status: "executed", result: { ok: true } });
const secondInvocation = invocation({ id: "tool-new", status: "executed", result: { ok: true } });
const mergedInvocations = mergeInvocations([firstInvocation], [firstInvocation, secondInvocation]);
if (mergedInvocations.length !== 2 || mergedInvocations[0]?.id !== "tool-old" || mergedInvocations[1]?.id !== "tool-new") {
  throw new Error("Expected session tool invocations to accumulate by id across conversation turns.");
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

const graphProps = {
  tools: [
    toolManifest("wazuh.alerts.search", "medium", ["plugin", "wazuh"]),
    toolManifest("case.note.read", "low")
  ],
  mcpTools: [],
  plugins: [{
    id: "wazuh",
    name: "Wazuh",
    version: "1.0.0",
    description: "Wazuh plugin.",
    status: "loaded",
    toolCount: 1,
    skillCount: 0
  }],
  sessions: [],
  activeSession: null,
  streamArtifacts: [],
  streamToolInvocations: [],
  health: null
} satisfies KnowledgeGraphProps;
const collapsedGraph = buildKnowledgeGraphData(graphProps, new Set());
for (const expectedId of ["agent-root", "plugin-wazuh", "tool-case.note.read"]) {
  if (!collapsedGraph.nodes.some((node) => node.id === expectedId)) {
    throw new Error(`Expected collapsed knowledge graph to contain ${expectedId}.`);
  }
}
if (collapsedGraph.nodes.some((node) => node.id === "tool-wazuh.alerts.search")) {
  throw new Error("Expected plugin tools to stay hidden before their plugin is expanded.");
}
const expandedGraph = buildKnowledgeGraphData(graphProps, new Set(["wazuh"]));
if (!expandedGraph.nodes.some((node) => node.id === "tool-wazuh.alerts.search")) {
  throw new Error("Expected a plugin tool to appear after its plugin is expanded.");
}
if (!expandedGraph.edges.some((edge) => edge.source === "plugin-wazuh" && edge.target === "tool-wazuh.alerts.search")) {
  throw new Error("Expected expanded plugin tools to remain attached to their owning plugin.");
}
for (const [type, expected] of Object.entries({
  tool: "#d97706",
  session: "#2563eb",
  artifact: "#64748b",
  agent: "#52525b"
})) {
  if (KNOWLEDGE_GRAPH_NODE_STYLE[type as keyof typeof KNOWLEDGE_GRAPH_NODE_STYLE].color !== expected) {
    throw new Error(`Expected ${type} graph color to match design/web-ui-tokens.`);
  }
}
if (KNOWLEDGE_GRAPH_NODE_STYLE.agent.bg !== "#f9f8f6") {
  throw new Error("Expected the central Agent node to retain its ivory fill.");
}
if (KNOWLEDGE_GRAPH_EDGE_STYLE.default !== "#cbd5e1" || KNOWLEDGE_GRAPH_EDGE_STYLE.highlighted !== "#64748b") {
  throw new Error("Expected knowledge graph edges to match design/web-ui-tokens.");
}
if (new Set(Object.values(KNOWLEDGE_GRAPH_NODE_STYLE).map((style) => style.color)).size !== Object.keys(KNOWLEDGE_GRAPH_NODE_STYLE).length) {
  throw new Error("Expected each knowledge graph node type to have a distinct functional color.");
}

function cssHexToken(css: string, name: string): string {
  const match = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!match?.[1]) {
    throw new Error(`Expected CSS token --${name} to use an auditable six-digit hex value.`);
  }
  return match[1];
}

function contrastRatio(first: string, second: string): number {
  const brighter = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (brighter + 0.05) / (darker + 0.05);
}

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const [red, green, blue] = channels.map((channel) => (
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  ));
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}
