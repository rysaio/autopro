import { rm } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { StreamableHTTPClientTransportOptions } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { buildServer } from "../src/app.js";
import { testConfig } from "./fixtures/testConfig.js";

describe("Streamable HTTP MCP endpoint", () => {
  it("serves registry tools through a real MCP client transport", async () => {
    const sandboxRoot = path.resolve("runtime/streamable-mcp-sandbox");
    const approvalStorePath = path.resolve("runtime/streamable-mcp-approvals/pending.json");
    await rm(sandboxRoot, { recursive: true, force: true });
    await rm(path.dirname(approvalStorePath), { recursive: true, force: true });
    const app = buildServer(testConfig({
      SECOPS_ACTION_LEVEL: "sandbox",
      SECOPS_SANDBOX_ROOT: sandboxRoot,
      SECOPS_APPROVAL_STORE_PATH: approvalStorePath
    }));
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const { client, transport } = mcpClient(address);

    try {
      await client.connect(transport);

      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain("secops_ioc_enrich");
      expect(tools.tools.map((tool) => tool.name)).toContain("secops_full_access_exec");
      expect(tools.tools.map((tool) => tool.name)).toContain("secops_case_note_write");

      const readOnlyResult = await client.callTool({
        name: "secops_ioc_enrich",
        arguments: { indicator: "198.51.100.23" }
      });
      expect(firstText(readOnlyResult)).toContain('"status": "executed"');

      const actionResult = await client.callTool({
        name: "secops_case_note_write",
        arguments: {
          caseId: "INC-MCP-STREAM",
          title: "Streamable MCP note",
          body: "This should wait for approval."
        }
      });
      expect(firstText(actionResult)).toContain('"status": "pending_approval"');

      const approvals = await app.inject({
        method: "GET",
        url: "/api/approvals"
      });
      expect(approvals.json().approvals).toHaveLength(1);
    } finally {
      await client.close();
      await transport.close();
      await app.close();
      await rm(sandboxRoot, { recursive: true, force: true });
      await rm(path.dirname(approvalStorePath), { recursive: true, force: true });
    }
  });

  it("keeps invalid Streamable MCP calls and denied actions out of approvals", async () => {
    const sandboxRoot = path.resolve("runtime/streamable-mcp-policy-sandbox");
    const approvalStorePath = path.resolve("runtime/streamable-mcp-policy-approvals/pending.json");
    await rm(sandboxRoot, { recursive: true, force: true });
    await rm(path.dirname(approvalStorePath), { recursive: true, force: true });
    const app = buildServer(testConfig({
      SECOPS_ACTION_LEVEL: "sandbox",
      SECOPS_SANDBOX_ROOT: sandboxRoot,
      SECOPS_APPROVAL_STORE_PATH: approvalStorePath
    }));
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const invalid = mcpClient(address);
    const denied = mcpClient(address, {
      requestInit: {
        headers: {
          "x-secops-permission-mode": "deny"
        }
      }
    });
    const invalidHeader = mcpClient(address, {
      requestInit: {
        headers: {
          "x-secops-permission-mode": "definitely-not-auto"
        }
      }
    });

    try {
      await invalid.client.connect(invalid.transport);
      const invalidResult = await invalid.client.callTool({
        name: "secops_case_note_write",
        arguments: {
          caseId: "INC-MCP-INVALID",
          title: "Missing body"
        }
      });
      expect(invalidResult.isError).toBe(true);
      expect(firstText(invalidResult)).toContain("Input validation error");

      let approvals = await app.inject({
        method: "GET",
        url: "/api/approvals"
      });
      expect(approvals.json().approvals).toHaveLength(0);

      await denied.client.connect(denied.transport);
      const deniedResult = await denied.client.callTool({
        name: "secops_case_note_write",
        arguments: {
          caseId: "INC-MCP-DENY",
          title: "Denied Streamable MCP note",
          body: "This should not be persisted or queued."
        }
      });
      expect(firstText(deniedResult)).toContain('"status": "denied"');

      approvals = await app.inject({
        method: "GET",
        url: "/api/approvals"
      });
      expect(approvals.json().approvals).toHaveLength(0);

      await invalidHeader.client.connect(invalidHeader.transport);
      const pendingResult = await invalidHeader.client.callTool({
        name: "secops_case_note_write",
        arguments: {
          caseId: "INC-MCP-BAD-HEADER",
          title: "Bad header fallback",
          body: "Invalid permission header should fall back to ask."
        }
      });
      expect(firstText(pendingResult)).toContain('"status": "pending_approval"');

      approvals = await app.inject({
        method: "GET",
        url: "/api/approvals"
      });
      expect(approvals.json().approvals).toHaveLength(1);
    } finally {
      await invalid.client.close();
      await invalid.transport.close();
      await denied.client.close();
      await denied.transport.close();
      await invalidHeader.client.close();
      await invalidHeader.transport.close();
      await app.close();
      await rm(sandboxRoot, { recursive: true, force: true });
      await rm(path.dirname(approvalStorePath), { recursive: true, force: true });
    }
  });
});

function firstText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = "content" in result ? result.content : [];
  const text = content.find((item) => item.type === "text");
  return text?.type === "text" ? text.text : "";
}

function mcpClient(address: string, options?: StreamableHTTPClientTransportOptions) {
  return {
    transport: new StreamableHTTPClientTransport(new URL("/api/mcp", address), options),
    client: new Client({
      name: "secops-agent-test",
      version: "0.1.0"
    })
  };
}
