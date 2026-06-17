import type { AgentRun, AuditEvent, EvidenceArtifact } from "@secops-agent/shared";
import { missingModelConfig, type AppConfig } from "../src/config.js";
import { createAiSdkModel } from "../src/providers/aiSdkModelFactory.js";
import { AgentRuntime } from "../src/runtime/agentRuntime.js";
import { ToolRegistry } from "../src/tools/registry.js";

export interface ProviderToolSmokeResult {
  provider: string;
  model: string;
  status: AgentRun["status"];
  toolCalls: string[];
  artifactKinds: EvidenceArtifact["kind"][];
  auditEvents: AuditEvent["type"][];
  receivedAssistantMessage: boolean;
  contentPreview: string | null;
}

const SMOKE_PROMPT = "For a harmless smoke test, request bounded IOC enrichment for documentation IP 198.51.100.23.";

export async function runProviderToolSmoke(config: AppConfig): Promise<ProviderToolSmokeResult> {
  const missing = missingModelConfig(config);
  if (missing.length) {
    throw new Error(`Model provider configuration is required for provider smoke testing. Missing: ${missing.join(", ")}.`);
  }

  const runtime = new AgentRuntime({
    model: createAiSdkModel(config),
    registry: new ToolRegistry(),
    modelName: config.model,
    providerLabel: config.provider,
    actionLevel: "observe",
    sandboxRoot: config.sandboxRoot,
    workspaceRoot: config.workspaceRoot,
    maxToolRounds: 2
  });

  const run = await runtime.run({
    messages: [
      {
        role: "user",
        content: SMOKE_PROMPT
      }
    ],
    enabledTools: ["ioc.enrich"],
    permissionMode: "auto"
  });
  const finalAssistant = [...run.messages].reverse().find((message) => message.role === "assistant");

  return {
    provider: config.provider,
    model: config.model,
    status: run.status,
    toolCalls: run.toolInvocations.map((invocation) => invocation.toolName),
    artifactKinds: run.artifacts.map((artifact) => artifact.kind),
    auditEvents: run.audit.map((event) => event.type),
    receivedAssistantMessage: Boolean(finalAssistant),
    contentPreview: finalAssistant?.content.slice(0, 240) ?? null
  };
}
