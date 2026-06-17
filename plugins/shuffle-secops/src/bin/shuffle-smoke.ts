#!/usr/bin/env node
import { shuffleConfigStatus } from "../core/configStatus.js";
import { createShuffleTools } from "../tools/registry.js";
import type { ShuffleExecutionContext, ShuffleExecutionResult, ShufflePluginTool } from "../tools/types.js";

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
  notes: string[];
}

const result = await runShuffleSmoke(process.env, createShuffleTools());
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exitCode = result.ok ? 0 : 1;

async function runShuffleSmoke(env: NodeJS.ProcessEnv, toolList: ShufflePluginTool[]): Promise<SmokeResult> {
  const runId = `shuffle-package-smoke-${crypto.randomUUID()}`;
  const context: ShuffleExecutionContext = {
    runId,
    permissionMode: "auto",
    actionLevel: "observe"
  };
  const checks: SmokeCheck[] = [];
  const status = shuffleConfigStatus(env);
  checks.push({
    name: "shuffle.config.status",
    status: "executed",
    summary: {
      api: status.api,
      smoke: status.smoke
    }
  });

  if (status.api.configured) {
    checks.push(await invoke(toolList, "shuffle.health", {}, context));
    checks.push(await invoke(toolList, "shuffle.workflows.list", { limit: positiveNumber(env.SHUFFLE_SMOKE_WORKFLOW_LIMIT, 5) }, context));
    const workflowId = env.SHUFFLE_SMOKE_WORKFLOW_ID?.trim();
    if (workflowId) {
      checks.push(await invoke(toolList, "shuffle.workflow.get", { workflowId }, context));
    }
    if (workflowId && status.smoke.executeWorkflowConfigured) {
      checks.push(
        await invoke(
          toolList,
          "shuffle.workflow.execute",
          {
            workflowId,
            executionArgumentJson: env.SHUFFLE_SMOKE_EXECUTION_ARGUMENT_JSON?.trim() || "{}",
            reason: "Shuffle package smoke workflow execution"
          },
          { ...context, actionLevel: "full-access" }
        )
      );
    } else {
      checks.push({
        name: "shuffle.workflow.execute",
        status: "skipped",
        summary: "Workflow execution is skipped unless SHUFFLE_SMOKE_EXECUTE_WORKFLOW=true and SHUFFLE_SMOKE_CONFIRM=execute-shuffle-workflow."
      });
    }
  } else {
    checks.push({
      name: "shuffle.api",
      status: "skipped",
      summary: "Set SHUFFLE_API_URL and SHUFFLE_API_KEY to verify live Shuffle API tools."
    });
  }

  if (env.SHUFFLE_SMOKE_WEBHOOK_URL?.trim()) {
    checks.push({
      name: "shuffle.webhook.trigger",
      status: "skipped",
      summary: "Webhook triggering is skipped by default. Use the tool through an approval-owning host or explicit live check."
    });
  }

  return {
    ok: checks.every((check) => check.status === "executed" || check.status === "skipped"),
    runId,
    checks,
    notes: [
      "Secrets are not printed.",
      "Smoke checks use Shuffle API tools only.",
      "Workflow execution and webhook calls are skipped unless explicitly confirmed."
    ]
  };
}

async function invoke(
  toolList: ShufflePluginTool[],
  manifestId: string,
  args: Record<string, unknown>,
  context: ShuffleExecutionContext
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

function summarize(result: ShuffleExecutionResult): unknown {
  const output = result.output;
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return undefined;
  }
  const record = output as Record<string, unknown>;
  return {
    endpointClass: record.endpointClass,
    endpointHost: record.endpointHost,
    count: record.count,
    workflowId: record.workflowId,
    executionId: record.executionId,
    apiReachable: record.apiReachable
  };
}

function positiveNumber(value: string | undefined, fallback: number): number {
  if (!value?.trim()) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
