import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import type { WazuhClient, WazuhIndexerClient } from "../src/index.js";
import { createWazuhMcpServer, createWazuhTools, type WazuhExecutionContext } from "../src/index.js";

describe("wazuh MCP server", () => {
  it("exposes Wazuh tools through a real MCP client transport", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createWazuhMcpServer({
      tools: createWazuhTools(() => fakeClient(), () => fakeIndexer()),
      context: context()
    });
    const client = new Client({
      name: "wazuh-secops-test",
      version: "0.1.0"
    });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain("secops_wazuh_config_status");
      expect(tools.tools.map((tool) => tool.name)).toContain("secops_wazuh_agent_network_summary");
      expect(tools.tools.map((tool) => tool.name)).toContain("secops_wazuh_block_ip");

      const status = await client.callTool({
        name: "secops_wazuh_config_status",
        arguments: {}
      });
      expect(firstText(status)).toContain('"status": "executed"');
      expect(firstText(status)).toContain('"serverApi"');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("denies standalone action tools unless explicitly enabled", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const fake = fakeClient();
    const server = createWazuhMcpServer({
      tools: createWazuhTools(() => fake, () => fakeIndexer()),
      context: context({ actionLevel: "full-access" })
    });
    const client = new Client({
      name: "wazuh-secops-test",
      version: "0.1.0"
    });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const result = await client.callTool({
        name: "secops_wazuh_block_ip",
        arguments: {
          ip: "203.0.113.10",
          agentIds: ["001"],
          command: "firewall-drop",
          durationSeconds: 60,
          reason: "MCP standalone safety test"
        }
      });

      expect(firstText(result)).toContain('"status": "denied"');
      expect(firstText(result)).toContain("Standalone Wazuh MCP does not own approvals");
      expect(activeResponseCount(fake)).toBe(0);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("starts the TypeScript stdio entrypoint for MCP discovery", async () => {
    const client = new Client({
      name: "wazuh-secops-stdio-test",
      version: "0.1.0"
    });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve("../../node_modules/tsx/dist/cli.mjs"), "src/bin/wazuh-mcp.ts"],
      cwd: path.resolve("."),
      stderr: "pipe"
    });

    try {
      await client.connect(transport);
      const tools = await client.listTools();

      expect(tools.tools.map((tool) => tool.name)).toContain("secops_wazuh_config_status");
      expect(tools.tools.map((tool) => tool.name)).toContain("secops_wazuh_block_ip");
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

function fakeClient(): WazuhClient {
  let activeResponses = 0;
  return {
    endpointHost: () => "wazuh.example:55000",
    allowedBlockIpCommands: () => ["firewall-drop"],
    maxBlockDurationSeconds: () => 3600,
    health: async () => ({
      root: { data: { api_version: "4.9.0" } },
      user: { data: { affected_items: [{ username: "api-user", roles: ["admin"] }] } }
    }),
    listAgents: async () => ({ data: { affected_items: [{ id: "001", name: "linux-1" }], total_affected_items: 1 } }),
    getAgent: async () => ({ data: { affected_items: [{ id: "001", name: "linux-1", ip: "10.0.0.10" }] } }),
    listSyscollector: async (_agentId, dataset) => {
      const responses: Record<string, unknown> = {
        netiface: { data: { affected_items: [{ name: "eth0", state: "up" }], total_affected_items: 1 } },
        netaddr: { data: { affected_items: [{ iface: "eth0", proto: "ipv4", address: "10.0.0.10" }], total_affected_items: 1 } },
        ports: { data: { affected_items: [{ protocol: "tcp", local_ip: "10.0.0.10", local_port: 22, state: "LISTEN", pid: 42, process: "sshd" }], total_affected_items: 1 } },
        processes: { data: { affected_items: [{ pid: 42, name: "sshd", cmd: "/usr/sbin/sshd" }], total_affected_items: 1 } }
      };
      return responses[dataset];
    },
    blockIp: async () => {
      activeResponses += 1;
      return { data: { affected_items: [] } };
    },
    activeResponseCount: () => activeResponses
  } as unknown as WazuhClient;
}

function fakeIndexer(): WazuhIndexerClient {
  return {
    endpointHost: () => "indexer.example:9200",
    alertsIndex: () => "wazuh-alerts-*",
    searchAlerts: async () => ({ hits: { total: { value: 0 }, hits: [] } })
  } as unknown as WazuhIndexerClient;
}

function activeResponseCount(client: WazuhClient): number {
  return (client as unknown as { activeResponseCount: () => number }).activeResponseCount();
}

function context(overrides: Partial<WazuhExecutionContext> = {}): WazuhExecutionContext {
  return {
    runId: "test-run",
    permissionMode: "auto",
    actionLevel: "observe",
    ...overrides
  };
}
