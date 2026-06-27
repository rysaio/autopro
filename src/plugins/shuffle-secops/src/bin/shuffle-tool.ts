#!/usr/bin/env node
import { createShuffleTools } from "../tools/registry.js";
import type { ShuffleExecutionContext } from "../tools/types.js";

const [manifestId, argsJson = "{}"] = process.argv.slice(2);

if (!manifestId) {
  process.stderr.write("Usage: shuffle-secops-tool <manifest-id> [json-args]\n");
  process.exitCode = 2;
} else {
  const result = await runTool(manifestId, argsJson);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.status === "executed" ? 0 : 1;
}

async function runTool(manifestId: string, argsJson: string) {
  const tools = createShuffleTools();
  const tool = tools.find((candidate) => candidate.manifest.id === manifestId || candidate.apiName === manifestId);
  if (!tool) {
    return {
      status: "failed",
      error: `Unknown Shuffle tool: ${manifestId}`
    };
  }
  const context: ShuffleExecutionContext = {
    runId: process.env.SHUFFLE_CLI_RUN_ID?.trim() || `shuffle-cli-${crypto.randomUUID()}`,
    permissionMode: "auto",
    actionLevel: actionLevel(process.env.SECOPS_ACTION_LEVEL)
  };
  if (tool.manifest.toolClass === "action" && process.env.SHUFFLE_CLI_ALLOW_ACTIONS !== "true") {
    return {
      status: "denied",
      error:
        "Shuffle CLI does not own approvals. Set SHUFFLE_CLI_ALLOW_ACTIONS=true and SECOPS_ACTION_LEVEL=full-access to enable action execution."
    };
  }
  if (tool.manifest.toolClass === "action" && context.actionLevel !== "full-access") {
    return {
      status: "denied",
      error: `Action tools require full-access in Shuffle CLI. Current action level is ${context.actionLevel}.`
    };
  }
  try {
    const args = parseArgs(argsJson);
    const output = await tool.execute(args, context);
    return {
      status: "executed",
      result: output.output,
      artifacts: output.artifacts ?? []
    };
  } catch (error) {
    return {
      status: "failed",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function parseArgs(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("json-args must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function actionLevel(value: string | undefined): ShuffleExecutionContext["actionLevel"] {
  return value === "sandbox" || value === "full-access" || value === "observe" ? value : "observe";
}
