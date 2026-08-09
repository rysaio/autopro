import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamResult
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { buildServer } from "../src/app.js";
import { streamResultFromGenerateResult } from "./fixtures/scriptedModel.js";
import { scriptedModelForRequest, testConfig } from "./fixtures/testConfig.js";

describe("agent request validation", () => {
  it("pre-routes locally and preserves the original valid conversation in the final request", async () => {
    const observed: LanguageModelV3CallOptions[] = [];
    const app = buildServer(testConfig(), {
      createModel: () => new RecordingModel(observed)
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/agent/run",
      payload: {
        messages: [
          { role: "user", content: "Earlier context marker: INC-42." },
          { role: "assistant", content: "Context acknowledged." },
          { role: "user", content: "Investigate IOC 198.51.100.23 with original-request-marker." }
        ],
        enabledTools: ["ioc.enrich", "case.note.write"],
        permissionMode: "auto"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      routing: {
        mode: "deterministic",
        selectedToolIds: ["ioc.enrich"],
        confidence: { level: "high" },
        additionalModelStage: { used: false }
      },
      metrics: {
        mode: "deterministic",
        model: { requestCount: 1, requests: [{ phase: "final", exposedToolCount: 1 }] }
      }
    });
    expect(observed).toHaveLength(1);
    expect(observed[0]?.tools?.map((tool) => tool.name)).toEqual(["secops_ioc_enrich"]);
    expect(JSON.stringify(observed[0]?.prompt)).toContain("Earlier context marker: INC-42.");
    expect(JSON.stringify(observed[0]?.prompt)).toContain("original-request-marker");

    await app.close();
  });

  it("exposes no tools for an explicit empty set or a denied action policy", async () => {
    const observed: LanguageModelV3CallOptions[] = [];
    const app = buildServer(testConfig(), {
      createModel: () => new RecordingModel(observed)
    });

    const empty = await app.inject({
      method: "POST",
      url: "/api/agent/run",
      payload: {
        messages: [{ role: "user", content: "Investigate IOC 198.51.100.23." }],
        enabledTools: []
      }
    });
    const deniedAction = await app.inject({
      method: "POST",
      url: "/api/agent/run",
      payload: {
        messages: [{ role: "user", content: "Write a case note for this investigation." }],
        enabledTools: ["case.note.write"],
        permissionMode: "deny"
      }
    });

    expect(empty.json().routing.selectedToolIds).toEqual([]);
    expect(deniedAction.json().routing.selectedToolIds).toEqual([]);
    expect(observed).toHaveLength(2);
    expect(observed.every((call) => (call.tools?.length ?? 0) === 0)).toBe(true);

    await app.close();
  });

  it("keeps layered routing available only through the rollback setting", async () => {
    const observed: LanguageModelV3CallOptions[] = [];
    const app = buildServer(testConfig({
      SECOPS_AGENT_ROUTING_MODE: "layered"
    }), {
      createModel: () => new RecordingModel(observed)
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/agent/run",
      payload: {
        messages: [{ role: "user", content: "rollback-original-request-marker" }],
        enabledTools: []
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      routing: {
        mode: "layered",
        selectedToolIds: [],
        additionalModelStage: { used: true }
      },
      metrics: {
        mode: "layered",
        model: { requestCount: 2 }
      }
    });
    expect(observed).toHaveLength(2);
    expect(JSON.stringify(observed[1]?.prompt)).toContain("rollback-original-request-marker");

    await app.close();
  });

  it("requires at least one user message for run APIs", async () => {
    const app = buildServer(testConfig({
    }));

    const empty = await app.inject({
      method: "POST",
      url: "/api/agent/run",
      payload: {
        messages: []
      }
    });
    expect(empty.statusCode).toBe(400);

    const assistantOnly = await app.inject({
      method: "POST",
      url: "/api/agent/events",
      payload: {
        messages: [
          {
            role: "assistant",
            content: "I should not start an agent run by myself."
          }
        ]
      }
    });
    expect(assistantOnly.statusCode).toBe(400);

    await app.close();
  });

  it("falls back to ask mode for invalid client-supplied permission mode", async () => {
    const sandboxRoot = path.resolve("runtime/agent-invalid-permission-sandbox");
    const approvalStorePath = path.resolve("runtime/agent-invalid-permission-approvals/pending.json");
    await rm(sandboxRoot, { recursive: true, force: true });
    await rm(path.dirname(approvalStorePath), { recursive: true, force: true });
    const app = buildServer(testConfig({
      SECOPS_ACTION_LEVEL: "sandbox",
      SECOPS_SANDBOX_ROOT: sandboxRoot,
      SECOPS_APPROVAL_STORE_PATH: approvalStorePath
    }), { createModel: scriptedModelForRequest, enableLayeredRouting: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/agent/run",
      payload: {
        messages: [
          {
            role: "user",
            content: "Write note for this invalid permission mode smoke test."
          }
        ],
        enabledTools: ["case.note.write"],
        permissionMode: "not-a-real-mode"
      }
    });

    expect(response.statusCode).toBe(200);
    const run = response.json();
    expect(run.status).toBe("needs_approval");
    expect(run.toolInvocations[0]?.status).toBe("pending_approval");
    expect(await caseFileCount(sandboxRoot, "INC-LOCAL-TEST")).toBe(0);

    const approvals = await app.inject({
      method: "GET",
      url: "/api/approvals"
    });
    expect(approvals.json().approvals).toHaveLength(1);

    await app.close();
    await rm(sandboxRoot, { recursive: true, force: true });
    await rm(path.dirname(approvalStorePath), { recursive: true, force: true });
  });

  it("returns an empty durable session list when postgres is not configured", async () => {
    const app = buildServer(testConfig({}));

    const sessions = await app.inject({
      method: "GET",
      url: "/api/sessions"
    });
    const missing = await app.inject({
      method: "GET",
      url: "/api/sessions/session-not-configured"
    });

    expect(sessions.statusCode).toBe(200);
    expect(sessions.json()).toEqual({ sessions: [] });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({
      error: "Durable session store is not configured"
    });

    await app.close();
  });
});

async function caseFileCount(sandboxRoot: string, caseId: string): Promise<number> {
  try {
    const files = await readdir(path.join(sandboxRoot, "cases", caseId));
    return files.length;
  } catch {
    return 0;
  }
}

class RecordingModel implements LanguageModelV3 {
  readonly specificationVersion = "v3" as const;
  readonly provider = "route-recording-provider";
  readonly modelId = "route-recording-model";
  readonly supportedUrls = {};

  constructor(private readonly observed: LanguageModelV3CallOptions[]) {}

  async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    this.observed.push(options);
    return recordingResult();
  }

  async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    this.observed.push(options);
    return streamResultFromGenerateResult(recordingResult());
  }
}

function recordingResult(): LanguageModelV3GenerateResult {
  return {
    content: [{ type: "text", text: "Recorded final response." }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 4, text: 4, reasoning: undefined }
    },
    warnings: []
  };
}
