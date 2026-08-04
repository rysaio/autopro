import { describe, expect, it } from "vitest";
import type { WazuhClient, WazuhIndexerClient } from "../src/index.js";
import { createWazuhTools, type WazuhExecutionContext } from "../src/index.js";

const expectedManifests = [
  "wazuh.config.status",
  "wazuh.health",
  "wazuh.agents.list",
  "wazuh.agent.get",
  "wazuh.agent.netaddr.list",
  "wazuh.agent.netiface.list",
  "wazuh.agent.ports.list",
  "wazuh.agent.processes.list",
  "wazuh.agent.network.summary",
  "wazuh.alerts.search",
  "wazuh.network.exposure.map",
  "wazuh.rule.hits.summary",
  "wazuh.agent.alerts.timeline",
  "wazuh.ip.activity.timeline",
  "wazuh.network.service.find",
  "wazuh.host.neighbors",
  "wazuh.lateral.suspects",
  "wazuh.lateral.path.summary",
  "wazuh.block_ip"
];

const expectedApiNames = [
  "secops_wazuh_config_status",
  "secops_wazuh_health",
  "secops_wazuh_agents_list",
  "secops_wazuh_agent_get",
  "secops_wazuh_agent_netaddr_list",
  "secops_wazuh_agent_netiface_list",
  "secops_wazuh_agent_ports_list",
  "secops_wazuh_agent_processes_list",
  "secops_wazuh_agent_network_summary",
  "secops_wazuh_alerts_search",
  "secops_wazuh_network_exposure_map",
  "secops_wazuh_rule_hits_summary",
  "secops_wazuh_agent_alerts_timeline",
  "secops_wazuh_ip_activity_timeline",
  "secops_wazuh_network_service_find",
  "secops_wazuh_host_neighbors",
  "secops_wazuh_lateral_suspects",
  "secops_wazuh_lateral_path_summary",
  "secops_wazuh_block_ip"
];

describe("wazuh plugin tools", () => {
  it("exports current Wazuh manifest ids and API names", () => {
    const tools = createWazuhTools(() => fakeClient(), () => fakeIndexer());

    expect(tools.map((tool) => tool.manifest.id)).toEqual(expectedManifests);
    expect(tools.map((tool) => tool.apiName)).toEqual(expectedApiNames);
    expect(tools.every((tool) => tool.manifest.skillPackId === "secops-wazuh")).toBe(true);
    expect(tools.every((tool) => tool.manifest.mcpCompatible)).toBe(true);
  });

  it("summarizes Linux network inventory from Wazuh syscollector responses", async () => {
    const tool = createWazuhTools(() => fakeClient(), () => fakeIndexer()).find(
      (candidate) => candidate.manifest.id === "wazuh.agent.network.summary"
    );

    const result = await tool?.execute({ agentId: "001" }, context());

    expect(result?.output).toMatchObject({
      agentId: "001",
      endpointClass: "wazuh.syscollector.network-summary",
      listeningPorts: {
        count: 1,
        items: [
          {
            localIp: "10.0.0.10",
            localPort: 22,
            process: "sshd"
          }
        ]
      },
      relatedProcesses: {
        count: 1,
        items: [
          {
            pid: 42,
            name: "sshd"
          }
        ]
      }
    });
    expect(result?.artifacts?.[0]?.kind).toBe("runtime");
  });

  it("validates block IP input before calling Active Response", async () => {
    const tool = createWazuhTools(() => fakeClient(), () => fakeIndexer()).find(
      (candidate) => candidate.manifest.id === "wazuh.block_ip"
    );

    await expect(
      tool?.execute(
        {
          ip: "not-an-ip",
          agentIds: ["001"],
          command: "firewall-drop",
          durationSeconds: 60,
          reason: "test"
        },
        context()
      )
    ).rejects.toThrow("ip must be a valid IPv4 or IPv6 address");
  });
});

function fakeClient(): WazuhClient {
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
        ports: {
          data: {
            affected_items: [{ protocol: "tcp", local_ip: "10.0.0.10", local_port: 22, state: "LISTEN", pid: 42, process: "sshd" }],
            total_affected_items: 1
          }
        },
        processes: { data: { affected_items: [{ pid: 42, name: "sshd", cmd: "/usr/sbin/sshd" }], total_affected_items: 1 } }
      };
      return responses[dataset];
    },
    blockIp: async () => ({ data: { affected_items: [] } })
  } as unknown as WazuhClient;
}

function fakeIndexer(): WazuhIndexerClient {
  return {
    endpointHost: () => "indexer.example:9200",
    alertsIndex: () => "wazuh-alerts-*",
    searchAlerts: async () => ({ hits: { total: { value: 0 }, hits: [] } })
  } as unknown as WazuhIndexerClient;
}

function context(): WazuhExecutionContext {
  return {
    runId: "test-run",
    permissionMode: "auto",
    actionLevel: "full-access"
  };
}
