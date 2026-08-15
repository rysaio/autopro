import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentRun, AgentRunEvent, ToolInvocation } from "@secops-agent/shared";
import { buildServer } from "../src/app.js";
import { scriptedModelForRequest, testConfig } from "./fixtures/testConfig.js";

describe("agent approval continuation", () => {
  it("keeps the SSE run open and continues the model after approval", async () => {
    const result = await exerciseApprovalDecision("approve", "approval-continuation");
    expect(result.finalRun.status).toBe("completed");
    expect(result.finalRun.toolInvocations[0]?.status).toBe("executed");
    expect(result.finalRun.toolInvocations[0]?.id).toBe(result.pendingCall.id);
    expect(result.finalRun.messages.some(
      (message) => message.role === "tool" && message.toolCallId === result.pendingCall.id
    )).toBe(true);
    expect(result.finalRun.messages.at(-1)?.role).toBe("assistant");
    expect(result.caseFileCount).toBe(1);
  });

  it("keeps the SSE run open and continues the model after denial", async () => {
    const result = await exerciseApprovalDecision("deny", "denial-continuation");
    expect(result.finalRun.status).toBe("completed");
    expect(result.finalRun.toolInvocations[0]?.status).toBe("denied");
    expect(result.finalRun.toolInvocations[0]?.id).toBe(result.pendingCall.id);
    expect(result.finalRun.messages.some(
      (message) => message.role === "tool" && message.toolCallId === result.pendingCall.id
    )).toBe(true);
    expect(result.finalRun.messages.at(-1)?.role).toBe("assistant");
    expect(result.caseFileCount).toBe(0);
  });
});

async function exerciseApprovalDecision(decision: "approve" | "deny", tag: string): Promise<{
  finalRun: AgentRun;
  pendingCall: ToolInvocation;
  caseFileCount: number;
}> {
  const sandboxRoot = path.resolve(`runtime/agent-${tag}-sandbox`);
  const approvalStorePath = path.resolve(`runtime/agent-${tag}-store/pending.json`);
  await rm(sandboxRoot, { recursive: true, force: true });
  await rm(path.dirname(approvalStorePath), { recursive: true, force: true });

  const app = buildServer(testConfig({
    SECOPS_ACTION_LEVEL: "sandbox",
    SECOPS_SANDBOX_ROOT: sandboxRoot,
    SECOPS_APPROVAL_STORE_PATH: approvalStorePath
  }), { createModel: scriptedModelForRequest, enableLayeredRouting: false });

  try {
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected test server to listen on a TCP port");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const response = await fetch(`${baseUrl}/api/agent/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: `Write note for this ${tag} smoke test.` }],
        enabledTools: ["case.note.write"],
        permissionMode: "ask"
      })
    });
    expect(response.status).toBe(200);
    expect(response.body).toBeTruthy();

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    const readNext = async () => {
      const chunk = await reader.read();
      if (!chunk.done) {
        buffered += decoder.decode(chunk.value, { stream: true });
      }
      return chunk.done;
    };
    const readUntil = async (predicate: (events: AgentRunEvent[]) => boolean) => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if (predicate(parseSseEvents(buffered))) {
          return parseSseEvents(buffered);
        }
        if (await readNext()) {
          break;
        }
      }
      throw new Error(`Timed out waiting for SSE condition. Buffer: ${buffered.slice(0, 500)}`);
    };

    const pendingEvents = await readUntil((events) =>
      events.some((event) => event.type === "tool" && event.invocation?.status === "pending_approval")
    );
    const pendingCall = pendingEvents.find(
      (event) => event.type === "tool" && event.invocation?.status === "pending_approval"
    )?.invocation;
    expect(pendingCall).toBeDefined();

    const approvalsResponse = await fetch(`${baseUrl}/api/approvals`);
    expect(approvalsResponse.status).toBe(200);
    const approvalsBody = await approvalsResponse.json() as { approvals: Array<{ id: string }> };
    expect(approvalsBody.approvals).toHaveLength(1);

    const decisionResponse = await fetch(`${baseUrl}/api/approvals/${pendingCall!.id}/${decision}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    expect(decisionResponse.status).toBe(200);

    // 决策后 AI SDK 收到真实工具结果/拒绝结果，模型继续输出并正常结束 SSE。
    const completedEvents = await readUntil((events) =>
      events.some((event) => event.type === "run_completed")
    );
    const finalRun = completedEvents.find((event) => event.type === "run_completed")?.run;
    expect(finalRun).toBeDefined();
    expect(finalRun?.messages.at(-1)?.role).toBe("assistant");

    return {
      finalRun: finalRun!,
      pendingCall: pendingCall!,
      caseFileCount: await caseFileCount(sandboxRoot, "INC-LOCAL-TEST")
    };
  } finally {
    await app.close();
    await rm(sandboxRoot, { recursive: true, force: true });
    await rm(path.dirname(approvalStorePath), { recursive: true, force: true });
  }
}

function parseSseEvents(input: string): AgentRunEvent[] {
  return input
    .replace(/\r\n/g, "\n")
    .split("\n\n")
    .flatMap((chunk) => {
      const data = chunk
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data) {
        return [];
      }
      try {
        return [JSON.parse(data) as AgentRunEvent];
      } catch {
        return [];
      }
    });
}

async function caseFileCount(sandboxRoot: string, caseId: string): Promise<number> {
  try {
    const files = await readdir(path.join(sandboxRoot, "cases", caseId));
    return files.length;
  } catch {
    return 0;
  }
}
