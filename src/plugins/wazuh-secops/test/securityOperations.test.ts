import { describe, expect, it } from "vitest";
import type { WazuhClient, WazuhExecutionContext, WazuhIndexerClient } from "../src/index.js";
import { createWazuhTools } from "../src/index.js";

describe("wazuh security operations tools", () => {
  it("maps network exposure from agent addresses and listening ports", async () => {
    const tool = toolById("wazuh.network.exposure.map");

    const result = await tool.execute({ agentLimit: 10, portLimit: 50 }, context());

    expect(result.output).toMatchObject({
      endpointClass: "wazuh.syscollector.network-exposure-map",
      scannedAgents: 2,
      networks: [
        {
          network: "10.0.0.0/24",
          agentIds: ["001", "002"],
          addresses: ["10.0.0.10", "10.0.0.20"]
        }
      ],
      services: [
        {
          serviceKey: "tcp:22",
          protocol: "tcp",
          port: 22,
          agentIds: ["001"]
        },
        {
          serviceKey: "tcp:5432",
          protocol: "tcp",
          port: 5432,
          agentIds: ["002"]
        }
      ]
    });
  });

  it("summarizes rule hits from bounded alert samples", async () => {
    const tool = toolById("wazuh.rule.hits.summary");

    const result = await tool.execute({ timeWindowMinutes: 120, limit: 50, minimumLevel: 7 }, context());

    expect(result.output).toMatchObject({
      endpointClass: "wazuh.indexer.rule-hits-summary",
      filters: {
        timeWindowMinutes: 120,
        limit: 50,
        minimumLevel: 7
      },
      ruleHits: [
        {
          ruleId: "5710",
          level: 8,
          description: "sshd authentication failed",
          count: 2,
          agentIds: ["001", "002"],
          groups: ["authentication_failed", "sshd"]
        }
      ]
    });
  });
});

function toolById(id: string) {
  const tool = createWazuhTools(() => fakeClient(), () => fakeIndexer()).find((candidate) => candidate.manifest.id === id);
  if (!tool) {
    throw new Error(`Missing tool ${id}`);
  }
  return tool;
}

function fakeClient(): WazuhClient {
  return {
    listAgents: async () => ({
      data: {
        affected_items: [
          { id: "001", name: "linux-1", ip: "10.0.0.10" },
          { id: "002", name: "linux-2", ip: "10.0.0.20" }
        ],
        total_affected_items: 2
      }
    }),
    listSyscollector: async (agentId, dataset) => {
      if (dataset === "netaddr") {
        return {
          data: {
            affected_items: [
              {
                iface: "eth0",
                proto: "ipv4",
                address: agentId === "001" ? "10.0.0.10" : "10.0.0.20",
                netmask: "255.255.255.0"
              }
            ],
            total_affected_items: 1
          }
        };
      }
      if (dataset === "ports") {
        return {
          data: {
            affected_items: [
              agentId === "001"
                ? { protocol: "tcp", local_ip: "10.0.0.10", local_port: 22, state: "LISTEN", pid: 42, process: "sshd" }
                : { protocol: "tcp", local_ip: "10.0.0.20", local_port: 5432, state: "LISTEN", pid: 99, process: "postgres" }
            ],
            total_affected_items: 1
          }
        };
      }
      return { data: { affected_items: [], total_affected_items: 0 } };
    }
  } as unknown as WazuhClient;
}

function fakeIndexer(): WazuhIndexerClient {
  return {
    endpointHost: () => "indexer.example:9200",
    alertsIndex: () => "wazuh-alerts-*",
    searchAlerts: async () => ({
      hits: {
        total: { value: 2 },
        hits: [
          {
            _source: {
              timestamp: "2026-06-15T10:00:00Z",
              agent: { id: "001", name: "linux-1", ip: "10.0.0.10" },
              rule: {
                id: "5710",
                level: 8,
                description: "sshd authentication failed",
                groups: ["sshd", "authentication_failed"]
              }
            }
          },
          {
            _source: {
              timestamp: "2026-06-15T10:01:00Z",
              agent: { id: "002", name: "linux-2", ip: "10.0.0.20" },
              rule: {
                id: "5710",
                level: 8,
                description: "sshd authentication failed",
                groups: ["sshd", "authentication_failed"]
              }
            }
          }
        ]
      }
    })
  } as unknown as WazuhIndexerClient;
}

function context(): WazuhExecutionContext {
  return {
    runId: "test-run",
    permissionMode: "auto",
    actionLevel: "observe"
  };
}
