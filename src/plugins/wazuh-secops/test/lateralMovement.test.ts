import { describe, expect, it } from "vitest";
import type { WazuhClient, WazuhIndexerClient } from "../src/index.js";
import { createWazuhTools, type WazuhExecutionContext } from "../src/index.js";

describe("wazuh lateral analysis tools", () => {
  it("finds exposed services from bounded syscollector port inventory", async () => {
    const tool = toolById("wazuh.network.service.find");

    const result = await tool.execute({ port: 22, agentLimit: 10 }, context());

    expect(result.output).toMatchObject({
      endpointClass: "wazuh.syscollector.network-service-find",
      scannedAgents: 2,
      matches: [
        {
          agent: { id: "001", name: "linux-1" },
          port: { localIp: "10.0.0.10", localPort: 22, process: "sshd" },
          evidenceType: "direct-syscollector-port"
        }
      ]
    });
  });

  it("builds an IP activity timeline with direct evidence and inferred relationships", async () => {
    const tool = toolById("wazuh.ip.activity.timeline");

    const result = await tool.execute({ ip: "10.0.0.20", timeWindowMinutes: 120 }, context());

    expect(result.output).toMatchObject({
      endpointClass: "wazuh.indexer.ip-activity-timeline",
      filters: {
        relatedIp: "10.0.0.20",
        timeWindowMinutes: 120
      },
      directEvidence: [
        {
          sourceIp: "10.0.0.20",
          destinationIp: "10.0.0.10",
          evidenceType: "direct-wazuh-alert"
        }
      ],
      inferredCorrelations: [
        {
          sourceIp: "10.0.0.20",
          destinationIp: "10.0.0.10",
          alertCount: 1
        }
      ]
    });
  });

  it("correlates host neighbors from shared syscollector networks", async () => {
    const tool = toolById("wazuh.host.neighbors");

    const result = await tool.execute({ agentId: "001", agentLimit: 10 }, context());

    expect(result.output).toMatchObject({
      endpointClass: "wazuh.lateral.host-neighbors",
      agentId: "001",
      directEvidence: [
        {
          neighbor: { id: "002", name: "linux-2" },
          evidenceType: "direct-shared-syscollector-network",
          sharedNetworks: [
            {
              network: "10.0.0.0/24",
              targetAddress: "10.0.0.10",
              neighborAddress: "10.0.0.20"
            }
          ]
        }
      ]
    });
  });

  it("labels lateral suspect and path output as inference over direct alerts", async () => {
    const suspectTool = toolById("wazuh.lateral.suspects");
    const pathTool = toolById("wazuh.lateral.path.summary");

    const suspects = await suspectTool.execute({ timeWindowMinutes: 60, limit: 50 }, context());
    const path = await pathTool.execute({ sourceIp: "10.0.0.20", targetIp: "10.0.0.10" }, context());

    expect(suspects.output).toMatchObject({
      endpointClass: "wazuh.lateral.suspects",
      inferredCorrelations: [
        {
          sourceIp: "10.0.0.20",
          mappedAgent: { id: "002", name: "linux-2" },
          reasons: expect.arrayContaining(["ssh-related alert", "authentication failure indicator"])
        }
      ]
    });
    expect(JSON.stringify(suspects.output)).toContain("validate");
    expect(path.output).toMatchObject({
      endpointClass: "wazuh.lateral.path-summary",
      directEvidence: [
        {
          sourceIp: "10.0.0.20",
          destinationIp: "10.0.0.10"
        }
      ],
      inferredCorrelations: [
        {
          sourceIp: "10.0.0.20",
          destinationIp: "10.0.0.10",
          alertCount: 1
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
    listSyscollector: async (agentId, dataset, query) => {
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
      if (dataset === "ports" && agentId === "001" && query.q === "local_port=22") {
        return {
          data: {
            affected_items: [
              { protocol: "tcp", local_ip: "10.0.0.10", local_port: 22, state: "LISTEN", pid: 42, process: "sshd" }
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
        total: { value: 1 },
        hits: [
          {
            _source: {
              timestamp: "2026-06-15T10:00:00Z",
              agent: { id: "001", name: "linux-1", ip: "10.0.0.10" },
              rule: { id: "5710", level: 8, description: "sshd authentication failed", groups: ["syslog", "sshd"] },
              data: { srcip: "10.0.0.20", dstip: "10.0.0.10", dstuser: "root" },
              location: "/var/log/auth.log",
              full_log: "sshd authentication failed for root from 10.0.0.20"
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
