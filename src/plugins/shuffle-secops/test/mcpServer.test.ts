import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createShuffleMcpServer, createShuffleTools, type ShuffleExecutionContext, ShuffleClient } from "../src/index.js";

describe("shuffle MCP server", () => {
  it("exposes Shuffle tools through a real MCP client transport", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createShuffleMcpServer({
      tools: createShuffleTools(() => fakeClient()),
      context: context()
    });
    const client = new Client({
      name: "shuffle-secops-test",
      version: "0.1.0"
    });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain("secops_shuffle_config_status");
      expect(tools.tools.map((tool) => tool.name)).toContain("secops_shuffle_workflow_execute");
      expect(tools.tools.map((tool) => tool.name)).toContain("secops_shuffle_wazuh_integration_render");
      expect(tools.tools.map((tool) => tool.name)).toContain("secops_shuffle_wazuh_alert_forward");

      const status = await client.callTool({
        name: "secops_shuffle_config_status",
        arguments: {}
      });
      expect(firstText(status)).toContain('"status": "executed"');
      expect(firstText(status)).toContain('"api"');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("denies standalone action tools unless explicitly enabled", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const fake = fakeClient();
    const server = createShuffleMcpServer({
      tools: createShuffleTools(() => fake),
      context: context({ actionLevel: "full-access" })
    });
    const client = new Client({
      name: "shuffle-secops-test",
      version: "0.1.0"
    });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const result = await client.callTool({
        name: "secops_shuffle_workflow_execute",
        arguments: {
          workflowId: "wf-1",
          executionArgumentJson: "{}",
          reason: "MCP standalone safety test"
        }
      });

      expect(firstText(result)).toContain('"status": "denied"');
      expect(firstText(result)).toContain("Standalone Shuffle MCP does not own approvals");
      expect(fake.executedCount()).toBe(0);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("starts the TypeScript stdio entrypoint for MCP discovery", async () => {
    const client = new Client({
      name: "shuffle-secops-stdio-test",
      version: "0.1.0"
    });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve("../../node_modules/tsx/dist/cli.mjs"), "src/bin/shuffle-mcp.ts"],
      cwd: path.resolve("."),
      stderr: "pipe"
    });

    try {
      await client.connect(transport);
      const tools = await client.listTools();

      expect(tools.tools.map((tool) => tool.name)).toContain("secops_shuffle_config_status");
      expect(tools.tools.map((tool) => tool.name)).toContain("secops_shuffle_mcp_call");
    } finally {
      await client.close();
      await transport.close();
    }
  });
});

function firstText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = "content" in result ? result.content : [];
  const text = content.find((item) => item.type === "text");
  return text?.type === "text" ? text.text : "";
}

function fakeClient() {
  let executions = 0;
  return {
    endpointHost: () => "shuffle.example",
    health: async () => [{ id: "wf-1" }],
    listWorkflows: async () => [{ id: "wf-1", name: "Wazuh alert triage" }],
    getWorkflow: async (workflowId: string) => ({ id: workflowId, name: "Wazuh alert triage" }),
    executeWorkflow: async () => {
      executions += 1;
      return { execution_id: "exec-1" };
    },
    listWorkflowExecutions: async () => [{ execution_id: "exec-1" }],
    getExecutionResult: async () => ({ success: true }),
    listApps: async () => [{ id: "app-1" }],
    callShuffleMcp: async () => ({ result: "pong" }),
    triggerWebhook: async () => ({ ok: true }),
    executedCount: () => executions
  } as unknown as ShuffleClient & { executedCount: () => number };
}

function context(overrides: Partial<ShuffleExecutionContext> = {}): ShuffleExecutionContext {
  return {
    runId: "test-run",
    permissionMode: "auto",
    actionLevel: "observe",
    ...overrides
  };
}
