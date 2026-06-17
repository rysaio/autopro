#!/usr/bin/env node
import { createWazuhTools } from "../tools/registry.js";
import { wazuhConfigStatus } from "../core/configStatus.js";
import type { WazuhExecutionContext, WazuhExecutionResult, WazuhPluginTool } from "../tools/types.js";

interface SmokeCheck {
  name: string;
  status: "executed" | "failed" | "skipped";
  error?: string;
  summary?: unknown;
}

interface SmokeResult {
  ok: boolean;
  runId: string;
  checks: SmokeCheck[];
  selectedAgentId?: string;
  notes: string[];
}

const tools = createWazuhTools();
const result = await runWazuhSmoke(process.env, tools);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exitCode = result.ok ? 0 : 1;

async function runWazuhSmoke(env: NodeJS.ProcessEnv, toolList: WazuhPluginTool[]): Promise<SmokeResult> {
  const runId = `wazuh-package-smoke-${crypto.randomUUID()}`;
  const context: WazuhExecutionContext = {
    runId,
    permissionMode: "auto",
    actionLevel: "observe"
  };
  const checks: SmokeCheck[] = [];
  const status = wazuhConfigStatus(env);
  checks.push({
    name: "wazuh.config.status",
    status: "executed",
    summary: {
      serverApi: configSummary(status.serverApi),
      indexer: configSummary(status.indexer),
      smoke: status.smoke
    }
  });

  let selectedAgentId = env.WAZUH_SMOKE_AGENT_ID?.trim() || undefined;
  if (status.serverApi.configured) {
    checks.push(await invoke(toolList, "wazuh.health", {}, context));
    const agents = await invoke(toolList, "wazuh.agents.list", { status: "active", limit: 5 }, context);
    checks.push(agents);
    selectedAgentId ??= firstAgentId(agents.summary);
    if (selectedAgentId) {
      checks.push(await invoke(toolList, "wazuh.agent.network.summary", {
        agentId: selectedAgentId,
        portLimit: 25,
        processLimit: 25
      }, context));
      checks.push(await invoke(toolList, "wazuh.network.exposure.map", {
        status: "active",
        agentLimit: 10,
        portLimit: 25
      }, context));
    } else {
      checks.push({
        name: "wazuh.agent.network.summary",
        status: "skipped",
        summary: "No active agent id found. Set WAZUH_SMOKE_AGENT_ID to verify syscollector endpoints."
      });
    }
  } else {
    checks.push({
      name: "wazuh.server-api",
      status: "skipped",
      summary: "Set WAZUH_API_URL, WAZUH_API_USER, and WAZUH_API_PASSWORD to verify Wazuh Server API tools."
    });
  }

  if (status.indexer.configured) {
    const alertArgs = {
      timeWindowMinutes: positiveNumber(env.WAZUH_SMOKE_ALERT_WINDOW_MINUTES, 60),
      limit: positiveNumber(env.WAZUH_SMOKE_ALERT_LIMIT, 5)
    };
    checks.push(await invoke(toolList, "wazuh.alerts.search", alertArgs, context));
    checks.push(await invoke(toolList, "wazuh.rule.hits.summary", alertArgs, context));
    if (env.WAZUH_SMOKE_ALERT_SOURCE_IP?.trim()) {
      checks.push(await invoke(toolList, "wazuh.ip.activity.timeline", {
        ip: env.WAZUH_SMOKE_ALERT_SOURCE_IP.trim(),
        ...alertArgs
      }, context));
    }
  } else {
    checks.push({
      name: "wazuh.indexer",
      status: "skipped",
      summary: "Set WAZUH_INDEXER_URL, WAZUH_INDEXER_USER, and WAZUH_INDEXER_PASSWORD to verify Indexer tools."
    });
  }

  const blockIp = env.WAZUH_SMOKE_BLOCK_IP?.trim();
  if (blockIp && env.WAZUH_SMOKE_EXECUTE_BLOCK === "true" && env.WAZUH_SMOKE_CONFIRM === "execute-active-response") {
    checks.push(await invoke(toolList, "wazuh.block_ip", {
      ip: blockIp,
      agentIds: [env.WAZUH_SMOKE_BLOCK_AGENT_ID?.trim() || selectedAgentId].filter(Boolean),
      command: env.WAZUH_SMOKE_BLOCK_COMMAND?.trim() || "firewall-drop",
      durationSeconds: positiveNumber(env.WAZUH_SMOKE_BLOCK_DURATION_SECONDS, 60),
      reason: env.WAZUH_SMOKE_BLOCK_REASON?.trim() || "Wazuh package smoke test Active Response check"
    }, {
      ...context,
      actionLevel: "full-access"
    }));
  } else {
    checks.push({
      name: "wazuh.block_ip",
      status: "skipped",
      summary: "Active Response is skipped unless WAZUH_SMOKE_EXECUTE_BLOCK=true and WAZUH_SMOKE_CONFIRM=execute-active-response."
    });
  }

  return {
    ok: checks.every((check) => check.status === "executed" || check.status === "skipped"),
    runId,
    checks,
    ...(selectedAgentId ? { selectedAgentId } : {}),
    notes: [
      "Secrets are not printed.",
      "Smoke checks use Wazuh API/Indexer tools only; no endpoint shell commands are run.",
      "Active Response is skipped unless explicitly confirmed."
    ]
  };
}

async function invoke(
  toolList: WazuhPluginTool[],
  manifestId: string,
  args: Record<string, unknown>,
  context: WazuhExecutionContext
): Promise<SmokeCheck> {
  const tool = toolList.find((candidate) => candidate.manifest.id === manifestId);
  if (!tool) {
    return { name: manifestId, status: "failed", error: "Tool is not registered" };
  }
  try {
    const result = await tool.execute(args, context);
    return {
      name: manifestId,
      status: "executed",
      summary: summarize(result)
    };
  } catch (error) {
    return {
      name: manifestId,
      status: "failed",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function summarize(result: WazuhExecutionResult): unknown {
  const output = result.output;
  if (!isRecord(output)) {
    return undefined;
  }
  return {
    endpointClass: output.endpointClass,
    endpointHost: output.endpointHost,
    index: output.index,
    count: output.count,
    total: output.total,
    scannedAgents: output.scannedAgents,
    totalAgents: output.totalAgents,
    targetIp: output.targetIp,
    targetAgentIds: output.targetAgentIds,
    command: output.command,
    version: output.version
  };
}

function configSummary(value: unknown): unknown {
  if (!isRecord(value)) {
    return undefined;
  }
  return {
    configured: value.configured,
    missing: value.missing,
    endpointHost: value.endpointHost,
    urlHasCredentials: value.urlHasCredentials,
    tlsVerify: value.tlsVerify,
    caCertConfigured: value.caCertConfigured
  };
}

function positiveNumber(value: string | undefined, fallback: number): number {
  if (!value?.trim()) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function firstAgentId(summary: unknown): string | undefined {
  if (!isRecord(summary) || !Array.isArray(summary.agents)) {
    return undefined;
  }
  const first = summary.agents.find(isRecord);
  return typeof first?.id === "string" ? first.id : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
