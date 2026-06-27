import { isIP } from "node:net";
import type { SkillManifest, ToolClass, ToolRisk } from "./types.js";
import { wazuhConfigStatus } from "../core/configStatus.js";
import { WazuhClient, type WazuhSyscollectorDataset } from "../core/wazuhClient.js";
import { WazuhIndexerClient, type WazuhAlertSearchInput } from "../core/indexerClient.js";
import {
  agentAlertTimeline,
  hostNeighbors,
  ipActivityTimeline,
  lateralPathSummary,
  lateralSuspects,
  networkServiceFind
} from "../workflows/lateralMovement.js";
import { createSecurityOperationsTools } from "./securityOperationsTools.js";
import type { ModelTool, WazuhExecutionContext, WazuhExecutionResult, WazuhPluginTool } from "./types.js";
import {
  affectedItems,
  agentSummary,
  alertHits,
  alertSummary,
  alertTotal,
  artifact,
  extractUser,
  extractVersion,
  netaddrSummary,
  netifaceSummary,
  portSummary,
  processSummary,
  relatedProcessSummaries,
  totalItems
} from "./helpers.js";

type ToolHandler = (args: Record<string, unknown>, context: WazuhExecutionContext) => Promise<WazuhExecutionResult>;

class WazuhTool implements WazuhPluginTool {
  constructor(
    readonly apiName: string,
    readonly manifest: SkillManifest,
    private readonly handler: ToolHandler
  ) {}

  toModelTool(): ModelTool {
    return {
      type: "function",
      function: {
        name: this.apiName,
        description: this.manifest.description,
        parameters: this.manifest.inputSchema
      }
    };
  }

  execute(args: Record<string, unknown>, context: WazuhExecutionContext): Promise<WazuhExecutionResult> {
    return this.handler(args, context);
  }
}

export function createWazuhTools(
  clientFactory: () => WazuhClient = memoizedWazuhClient(),
  indexerClientFactory: () => WazuhIndexerClient = memoizedWazuhIndexerClient()
): WazuhPluginTool[] {
  return [
    new WazuhTool(
      "secops_wazuh_config_status",
      manifest({
        id: "wazuh.config.status",
        name: "Wazuh Configuration Status",
        description:
          "Report sanitized Wazuh Server API, Wazuh Indexer, and smoke-test configuration readiness without exposing secrets.",
        toolClass: "perception",
        risk: "low",
        tags: ["wazuh", "configuration", "readiness", "read-only"],
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
          additionalProperties: false
        }
      }),
      async () => {
        const output = wazuhConfigStatus(process.env);
        return {
          output,
          artifacts: [artifact("Wazuh configuration status", "Sanitized Wazuh configuration readiness checked.", output)]
        };
      }
    ),
    new WazuhTool(
      "secops_wazuh_health",
      manifest({
        id: "wazuh.health",
        name: "Wazuh Health",
        description: "Verify Wazuh API connectivity and authentication without exposing credentials.",
        toolClass: "perception",
        risk: "low",
        tags: ["wazuh", "health", "read-only"],
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
          additionalProperties: false
        }
      }),
      async () => {
        const client = clientFactory();
        const health = await client.health();
        const output = {
          apiReachable: true,
          endpointHost: client.endpointHost(),
          version: extractVersion(health.root),
          authenticatedUser: extractUser(health.user),
          raw: {
            root: health.root,
            user: health.user
          }
        };
        return {
          output,
          artifacts: [artifact("Wazuh health", "Wazuh API authentication and connectivity verified.", output)]
        };
      }
    ),
    new WazuhTool(
      "secops_wazuh_agents_list",
      manifest({
        id: "wazuh.agents.list",
        name: "List Wazuh Agents",
        description: "List Wazuh agents for analyst scoping, with optional status, name, IP, group, and limit filters.",
        toolClass: "perception",
        risk: "low",
        tags: ["wazuh", "agents", "inventory", "read-only"],
        inputSchema: {
          type: "object",
          properties: {
            status: {
              type: "string",
              enum: ["active", "disconnected", "never_connected", "pending"],
              description: "Optional Wazuh agent connection status filter."
            },
            name: { type: "string", description: "Optional agent name filter." },
            ip: { type: "string", description: "Optional agent IP filter." },
            group: { type: "string", description: "Optional Wazuh group filter." },
            limit: { type: "number", description: "Maximum agents to return, from 1 to 500." }
          },
          required: [],
          additionalProperties: false
        }
      }),
      async (args) => {
        const query = agentListQuery(args);
        const response = await clientFactory().listAgents(query);
        const agents = affectedItems(response).map(agentSummary);
        const output = {
          count: agents.length,
          total: totalItems(response) ?? agents.length,
          filters: query,
          agents,
          raw: response
        };
        return {
          output,
          artifacts: [artifact("Wazuh agents", `${agents.length} Wazuh agent(s) returned.`, output)]
        };
      }
    ),
    new WazuhTool(
      "secops_wazuh_agent_get",
      manifest({
        id: "wazuh.agent.get",
        name: "Get Wazuh Agent",
        description: "Inspect one Wazuh agent identity, status, labels, groups, OS, and recent keepalive metadata.",
        toolClass: "perception",
        risk: "low",
        tags: ["wazuh", "agent", "inventory", "read-only"],
        inputSchema: {
          type: "object",
          properties: {
            agentId: { type: "string", description: "Wazuh agent id, for example 001." }
          },
          required: ["agentId"],
          additionalProperties: false
        }
      }),
      async (args) => {
        const agentId = requireAgentId(args, "agentId");
        const response = await clientFactory().getAgent(agentId);
        const item = affectedItems(response)[0] ?? response;
        const output = {
          agent: agentSummary(item),
          raw: response
        };
        return {
          output,
          artifacts: [artifact(`Wazuh agent: ${agentId}`, `Wazuh agent ${agentId} inspected.`, output)]
        };
      }
    ),
    syscollectorTool({
      apiName: "secops_wazuh_agent_netaddr_list",
      id: "wazuh.agent.netaddr.list",
      name: "List Wazuh Agent Network Addresses",
      description: "List syscollector network addresses for one explicit Wazuh agent.",
      dataset: "netaddr",
      resultKey: "addresses",
      artifactTitle: "Wazuh agent network addresses",
      summarize: netaddrSummary,
      clientFactory
    }),
    syscollectorTool({
      apiName: "secops_wazuh_agent_netiface_list",
      id: "wazuh.agent.netiface.list",
      name: "List Wazuh Agent Network Interfaces",
      description: "List syscollector network interfaces for one explicit Wazuh agent.",
      dataset: "netiface",
      resultKey: "interfaces",
      artifactTitle: "Wazuh agent network interfaces",
      summarize: netifaceSummary,
      clientFactory
    }),
    syscollectorTool({
      apiName: "secops_wazuh_agent_ports_list",
      id: "wazuh.agent.ports.list",
      name: "List Wazuh Agent Ports",
      description:
        "List syscollector network ports for one explicit Wazuh agent. Use q for Wazuh API filter expressions when needed.",
      dataset: "ports",
      resultKey: "ports",
      artifactTitle: "Wazuh agent ports",
      summarize: portSummary,
      clientFactory
    }),
    syscollectorTool({
      apiName: "secops_wazuh_agent_processes_list",
      id: "wazuh.agent.processes.list",
      name: "List Wazuh Agent Processes",
      description:
        "List syscollector processes for one explicit Wazuh agent to support host operations and port owner review.",
      dataset: "processes",
      resultKey: "processes",
      artifactTitle: "Wazuh agent processes",
      summarize: processSummary,
      clientFactory
    }),
    new WazuhTool(
      "secops_wazuh_agent_network_summary",
      manifest({
        id: "wazuh.agent.network.summary",
        name: "Summarize Wazuh Agent Network",
        description:
          "Build a bounded network monitoring summary for one Linux Wazuh agent from syscollector interfaces, addresses, listening ports, and related processes.",
        toolClass: "perception",
        risk: "low",
        tags: ["wazuh", "syscollector", "linux", "network", "summary", "read-only"],
        inputSchema: {
          type: "object",
          properties: {
            agentId: { type: "string", description: "Explicit Wazuh agent id, for example 001." },
            portLimit: { type: "number", description: "Maximum port records to inspect, from 1 to 500." },
            processLimit: { type: "number", description: "Maximum process records to inspect, from 1 to 500." },
            portQuery: {
              type: "string",
              description: "Optional Wazuh API q filter for ports. Defaults to state=LISTEN."
            }
          },
          required: ["agentId"],
          additionalProperties: false
        }
      }),
      async (args) => {
        const agentId = requireAgentId(args, "agentId");
        const query = networkSummaryQuery(args);
        const client = clientFactory();
        const netiface = await client.listSyscollector(agentId, "netiface", { limit: 100 });
        const netaddr = await client.listSyscollector(agentId, "netaddr", { limit: 100 });
        const portsResponse = await client.listSyscollector(agentId, "ports", {
          limit: query.portLimit,
          q: query.portQuery
        });
        const processesResponse = await client.listSyscollector(agentId, "processes", {
          limit: query.processLimit
        });
        const interfaces = affectedItems(netiface).map(netifaceSummary);
        const addresses = affectedItems(netaddr).map(netaddrSummary);
        const listeningPorts = affectedItems(portsResponse).map(portSummary);
        const processes = affectedItems(processesResponse).map(processSummary);
        const relatedProcesses = relatedProcessSummaries(listeningPorts, processes);
        const output = {
          agentId,
          endpointClass: "wazuh.syscollector.network-summary",
          filters: query,
          interfaces: {
            count: interfaces.length,
            total: totalItems(netiface) ?? interfaces.length,
            items: interfaces
          },
          addresses: {
            count: addresses.length,
            total: totalItems(netaddr) ?? addresses.length,
            items: addresses
          },
          listeningPorts: {
            count: listeningPorts.length,
            total: totalItems(portsResponse) ?? listeningPorts.length,
            items: listeningPorts
          },
          relatedProcesses: {
            count: relatedProcesses.length,
            total: totalItems(processesResponse) ?? processes.length,
            items: relatedProcesses
          },
          raw: {
            netiface,
            netaddr,
            ports: portsResponse,
            processes: processesResponse
          }
        };
        return {
          output,
          artifacts: [
            artifact(
              "Wazuh agent network summary",
              `${listeningPorts.length} listening/open port record(s) and ${interfaces.length} interface record(s) returned for Wazuh agent ${agentId}.`,
              output
            )
          ]
        };
      }
    ),
    new WazuhTool(
      "secops_wazuh_alerts_search",
      manifest({
        id: "wazuh.alerts.search",
        name: "Search Wazuh Alerts",
        description:
          "Search recent Wazuh alerts through a bounded Wazuh Indexer query by source IP, agent id, rule id, or time window.",
        toolClass: "perception",
        risk: "low",
        tags: ["wazuh", "alerts", "indexer", "opensearch", "read-only"],
        inputSchema: {
          type: "object",
          properties: {
            sourceIp: { type: "string", description: "Optional source IP to search in common Wazuh alert IP fields." },
            agentId: { type: "string", description: "Optional Wazuh agent id filter." },
            ruleId: { type: "string", description: "Optional Wazuh rule id filter." },
            timeWindowMinutes: { type: "number", description: "Lookback window in minutes, from 1 to 10080." },
            limit: { type: "number", description: "Maximum alerts to return, from 1 to 200." }
          },
          required: [],
          additionalProperties: false
        }
      }),
      async (args) => {
        const client = indexerClientFactory();
        const request = alertSearchRequest(args);
        const response = await client.searchAlerts(request);
        const alerts = alertHits(response).map(alertSummary);
        const output = {
          endpointClass: "wazuh.indexer.alerts-search",
          endpointHost: client.endpointHost(),
          index: client.alertsIndex(),
          count: alerts.length,
          total: alertTotal(response) ?? alerts.length,
          filters: request,
          alerts
        };
        return {
          output,
          artifacts: [artifact("Wazuh alerts search", `${alerts.length} Wazuh alert(s) returned.`, output)]
        };
      }
    ),
    ...createSecurityOperationsTools(clientFactory, indexerClientFactory),
    new WazuhTool(
      "secops_wazuh_agent_alerts_timeline",
      manifest({
        id: "wazuh.agent.alerts.timeline",
        name: "Wazuh Agent Alert Timeline",
        description: "Return a bounded Wazuh alert timeline for one agent, optionally narrowed by rule id.",
        toolClass: "perception",
        risk: "low",
        tags: ["wazuh", "alerts", "timeline", "agent", "read-only"],
        inputSchema: timelineSchema({
          agentId: { type: "string", description: "Explicit Wazuh agent id, for example 001." },
          ruleId: { type: "string", description: "Optional Wazuh rule id filter." }
        }, ["agentId"])
      }),
      async (args) => {
        const request = timelineRequest(args, { requireAgentId: true });
        const output = await agentAlertTimeline(indexerClientFactory(), request);
        return {
          output,
          artifacts: [artifact("Wazuh agent alert timeline", `Returned alert timeline for Wazuh agent ${request.agentId}.`, output)]
        };
      }
    ),
    new WazuhTool(
      "secops_wazuh_ip_activity_timeline",
      manifest({
        id: "wazuh.ip.activity.timeline",
        name: "Wazuh IP Activity Timeline",
        description: "Return a bounded Wazuh alert timeline for an IP across common source, destination, and agent IP fields.",
        toolClass: "perception",
        risk: "low",
        tags: ["wazuh", "alerts", "timeline", "ip", "read-only"],
        inputSchema: timelineSchema({
          ip: { type: "string", description: "IPv4 or IPv6 address to search across source, destination, and agent IP fields." },
          direction: {
            type: "string",
            enum: ["any", "source", "destination"],
            description: "Whether to match any, source-only, or destination-only IP fields."
          },
          ruleId: { type: "string", description: "Optional Wazuh rule id filter." }
        }, ["ip"])
      }),
      async (args) => {
        const request = ipTimelineRequest(args);
        const output = await ipActivityTimeline(indexerClientFactory(), request);
        return {
          output,
          artifacts: [artifact("Wazuh IP activity timeline", `Returned Wazuh activity timeline for IP ${args.ip}.`, output)]
        };
      }
    ),
    new WazuhTool(
      "secops_wazuh_network_service_find",
      manifest({
        id: "wazuh.network.service.find",
        name: "Find Wazuh Network Service",
        description:
          "Find Wazuh agents exposing a target port or service from bounded syscollector port inventory.",
        toolClass: "perception",
        risk: "low",
        tags: ["wazuh", "syscollector", "network", "service", "read-only"],
        inputSchema: {
          type: "object",
          properties: {
            port: { type: "number", description: "Optional local listening port to find, from 1 to 65535." },
            service: { type: "string", description: "Optional process/service name fragment to find." },
            protocol: { type: "string", description: "Optional protocol filter, for example tcp or udp." },
            status: {
              type: "string",
              enum: ["active", "disconnected", "never_connected", "pending"],
              description: "Optional Wazuh agent connection status filter."
            },
            agentLimit: { type: "number", description: "Maximum agents to scan, from 1 to 200." },
            portLimit: { type: "number", description: "Maximum port rows per agent, from 1 to 500." }
          },
          required: [],
          additionalProperties: false
        }
      }),
      async (args) => {
        const request = serviceFinderRequest(args);
        const output = await networkServiceFind(clientFactory(), request);
        return {
          output,
          artifacts: [artifact("Wazuh network service finder", "Searched bounded Wazuh syscollector port inventory.", output)]
        };
      }
    ),
    new WazuhTool(
      "secops_wazuh_host_neighbors",
      manifest({
        id: "wazuh.host.neighbors",
        name: "Find Wazuh Host Neighbors",
        description:
          "Find likely neighboring Wazuh agents from shared syscollector networks and recent alert IP references.",
        toolClass: "reasoning",
        risk: "low",
        tags: ["wazuh", "lateral", "neighbors", "inventory", "read-only"],
        inputSchema: {
          type: "object",
          properties: {
            agentId: { type: "string", description: "Explicit Wazuh agent id, for example 001." },
            agentLimit: { type: "number", description: "Maximum agents to compare, from 1 to 200." },
            timeWindowMinutes: { type: "number", description: "Recent alert lookback window in minutes, from 1 to 10080." },
            alertLimit: { type: "number", description: "Maximum alerts to sample, from 1 to 200." }
          },
          required: ["agentId"],
          additionalProperties: false
        }
      }),
      async (args) => {
        const request = hostNeighborsRequest(args);
        const output = await hostNeighbors(clientFactory(), indexerClientFactory(), request);
        return {
          output,
          artifacts: [artifact("Wazuh host neighbors", `Correlated neighbors for Wazuh agent ${request.agentId}.`, output)]
        };
      }
    ),
    new WazuhTool(
      "secops_wazuh_lateral_suspects",
      manifest({
        id: "wazuh.lateral.suspects",
        name: "Wazuh Lateral Movement Suspects",
        description:
          "Correlate recent Wazuh alerts for internal source IPs with lateral-movement indicators and known agent IPs.",
        toolClass: "reasoning",
        risk: "medium",
        tags: ["wazuh", "lateral", "alerts", "correlation", "read-only"],
        inputSchema: {
          type: "object",
          properties: {
            timeWindowMinutes: { type: "number", description: "Recent alert lookback window in minutes, from 1 to 10080." },
            limit: { type: "number", description: "Maximum alerts to inspect, from 1 to 200." },
            agentLimit: { type: "number", description: "Maximum agents to map by IP, from 1 to 200." }
          },
          required: [],
          additionalProperties: false
        }
      }),
      async (args) => {
        const request = lateralSuspectsRequest(args);
        const output = await lateralSuspects(clientFactory(), indexerClientFactory(), request);
        return {
          output,
          artifacts: [artifact("Wazuh lateral suspects", "Correlated recent Wazuh alerts for lateral-movement suspects.", output)]
        };
      }
    ),
    new WazuhTool(
      "secops_wazuh_lateral_path_summary",
      manifest({
        id: "wazuh.lateral.path.summary",
        name: "Wazuh Lateral Path Summary",
        description:
          "Summarize possible source-to-target movement paths from bounded Wazuh alert IP fields.",
        toolClass: "reasoning",
        risk: "medium",
        tags: ["wazuh", "lateral", "path", "alerts", "read-only"],
        inputSchema: {
          type: "object",
          properties: {
            sourceIp: { type: "string", description: "Optional source IP filter." },
            targetIp: { type: "string", description: "Optional target/destination IP filter." },
            agentId: { type: "string", description: "Optional Wazuh agent id filter." },
            timeWindowMinutes: { type: "number", description: "Recent alert lookback window in minutes, from 1 to 10080." },
            limit: { type: "number", description: "Maximum alerts to inspect, from 1 to 200." }
          },
          required: [],
          additionalProperties: false
        }
      }),
      async (args) => {
        const request = lateralPathRequest(args);
        const output = await lateralPathSummary(indexerClientFactory(), request);
        return {
          output,
          artifacts: [artifact("Wazuh lateral path summary", "Summarized possible lateral paths from Wazuh alerts.", output)]
        };
      }
    ),
    new WazuhTool(
      "secops_wazuh_block_ip",
      manifest({
        id: "wazuh.block_ip",
        name: "Block IP With Wazuh",
        description:
          "Block one IP on explicit Wazuh agents through an allowlisted Active Response command. Requires analyst approval outside full-access.",
        toolClass: "action",
        risk: "high",
        tags: ["wazuh", "active-response", "ip-block", "action"],
        inputSchema: {
          type: "object",
          properties: {
            ip: { type: "string", description: "IPv4 or IPv6 address to block." },
            agentIds: {
              type: "array",
              items: { type: "string" },
              description: "Explicit Wazuh agent ids. This tool never defaults to all agents."
            },
            command: {
              type: "string",
              enum: ["firewall-drop", "firewalld-drop", "route-null", "netsh"],
              description: "Allowlisted Wazuh Active Response command."
            },
            durationSeconds: {
              type: "number",
              description: "Requested block duration in seconds, bounded by WAZUH_MAX_BLOCK_DURATION_SECONDS."
            },
            reason: { type: "string", description: "Required analyst/audit reason for the block." }
          },
          required: ["ip", "agentIds", "command", "durationSeconds", "reason"],
          additionalProperties: false
        }
      }),
      async (args, context) => {
        const client = clientFactory();
        const request = blockIpRequest(args, client);
        const response = await client.blockIp(request);
        const output = {
          policyDecision: `executed under ${context.actionLevel} access level`,
          endpointClass: "wazuh.active-response",
          endpointHost: client.endpointHost(),
          targetIp: request.ip,
          targetAgentIds: request.agentIds,
          command: request.command,
          durationSeconds: request.durationSeconds,
          reason: request.reason,
          wazuhResponse: response
        };
        return {
          output,
          artifacts: [
            artifact(`Wazuh IP block: ${request.ip}`, `Requested ${request.command} on ${request.agentIds.length} Wazuh agent(s).`, output)
          ]
        };
      }
    )
  ];
}

function syscollectorTool(input: {
  apiName: string;
  id: string;
  name: string;
  description: string;
  dataset: WazuhSyscollectorDataset;
  resultKey: string;
  artifactTitle: string;
  summarize: (value: unknown) => Record<string, unknown>;
  clientFactory: () => WazuhClient;
}): WazuhPluginTool {
  return new WazuhTool(
    input.apiName,
    manifest({
      id: input.id,
      name: input.name,
      description: input.description,
      toolClass: "perception",
      risk: "low",
      tags: ["wazuh", "syscollector", "linux", "network", "read-only"],
      inputSchema: {
        type: "object",
        properties: {
          agentId: { type: "string", description: "Explicit Wazuh agent id, for example 001." },
          limit: { type: "number", description: "Maximum records to return, from 1 to 500." },
          query: {
            type: "string",
            description: "Optional Wazuh API q filter expression, for example state=LISTEN."
          }
        },
        required: ["agentId"],
        additionalProperties: false
      }
    }),
    async (args) => {
      const agentId = requireAgentId(args, "agentId");
      const query = syscollectorQuery(args);
      const response = await input.clientFactory().listSyscollector(agentId, input.dataset, query);
      const records = affectedItems(response).map(input.summarize);
      const output = {
        agentId,
        endpointClass: `wazuh.syscollector.${input.dataset}`,
        count: records.length,
        total: totalItems(response) ?? records.length,
        filters: query,
        [input.resultKey]: records,
        raw: response
      };
      return {
        output,
        artifacts: [
          artifact(input.artifactTitle, `${records.length} ${input.resultKey} record(s) returned for Wazuh agent ${agentId}.`, output)
        ]
      };
    }
  );
}

function memoizedWazuhClient(): () => WazuhClient {
  let client: WazuhClient | undefined;
  return () => {
    client ??= new WazuhClient();
    return client;
  };
}

function memoizedWazuhIndexerClient(): () => WazuhIndexerClient {
  let client: WazuhIndexerClient | undefined;
  return () => {
    client ??= new WazuhIndexerClient();
    return client;
  };
}

function manifest(input: {
  id: string;
  name: string;
  description: string;
  toolClass: ToolClass;
  risk: ToolRisk;
  tags: string[];
  inputSchema: SkillManifest["inputSchema"];
}): SkillManifest {
  return {
    ...input,
    skillPackId: "secops-wazuh",
    defaultPermission: input.toolClass === "action" ? "ask" : "auto",
    mcpCompatible: true
  };
}

function agentListQuery(args: Record<string, unknown>): Record<string, string | number | undefined> {
  const limit = optionalNumber(args, "limit") ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("limit must be an integer from 1 to 500");
  }
  const ip = optionalString(args, "ip");
  if (ip && isIP(ip) === 0) {
    throw new Error("ip must be a valid IPv4 or IPv6 address");
  }
  return {
    status: optionalString(args, "status"),
    name: optionalString(args, "name"),
    ip,
    group: optionalString(args, "group"),
    limit
  };
}

function syscollectorQuery(args: Record<string, unknown>): Record<string, string | number | undefined> {
  const limit = optionalNumber(args, "limit") ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("limit must be an integer from 1 to 500");
  }
  return {
    limit,
    q: optionalString(args, "query")
  };
}

function networkSummaryQuery(args: Record<string, unknown>): { portLimit: number; processLimit: number; portQuery: string } {
  const portLimit = optionalNumber(args, "portLimit") ?? 100;
  if (!Number.isInteger(portLimit) || portLimit < 1 || portLimit > 500) {
    throw new Error("portLimit must be an integer from 1 to 500");
  }
  const processLimit = optionalNumber(args, "processLimit") ?? 100;
  if (!Number.isInteger(processLimit) || processLimit < 1 || processLimit > 500) {
    throw new Error("processLimit must be an integer from 1 to 500");
  }
  return {
    portLimit,
    processLimit,
    portQuery: optionalString(args, "portQuery") ?? "state=LISTEN"
  };
}

function alertSearchRequest(args: Record<string, unknown>): WazuhAlertSearchInput {
  const relatedIp = optionalIp(args, "relatedIp");
  const sourceIp = optionalString(args, "sourceIp");
  if (sourceIp && isIP(sourceIp) === 0) {
    throw new Error("sourceIp must be a valid IPv4 or IPv6 address");
  }
  const destinationIp = optionalIp(args, "destinationIp");
  const agentId = optionalString(args, "agentId");
  if (agentId) {
    requireAgentId({ agentId }, "agentId");
  }
  const timeWindowMinutes = optionalNumber(args, "timeWindowMinutes") ?? 60;
  if (!Number.isInteger(timeWindowMinutes) || timeWindowMinutes < 1 || timeWindowMinutes > 10_080) {
    throw new Error("timeWindowMinutes must be an integer from 1 to 10080");
  }
  const limit = optionalNumber(args, "limit") ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new Error("limit must be an integer from 1 to 200");
  }
  const request: WazuhAlertSearchInput = {
    timeWindowMinutes,
    limit
  };
  if (relatedIp) {
    request.relatedIp = relatedIp;
  }
  if (sourceIp) {
    request.sourceIp = sourceIp;
  }
  if (destinationIp) {
    request.destinationIp = destinationIp;
  }
  if (agentId) {
    request.agentId = agentId;
  }
  const ruleId = optionalString(args, "ruleId");
  if (ruleId) {
    request.ruleId = ruleId;
  }
  return request;
}

function timelineSchema(
  properties: Record<string, unknown>,
  required: string[]
): SkillManifest["inputSchema"] {
  return {
    type: "object",
    properties: {
      ...properties,
      timeWindowMinutes: { type: "number", description: "Recent alert lookback window in minutes, from 1 to 10080." },
      limit: { type: "number", description: "Maximum alerts to return, from 1 to 200." }
    },
    required,
    additionalProperties: false
  };
}

function timelineRequest(args: Record<string, unknown>, options: { requireAgentId?: boolean } = {}) {
  const request = boundedAlertRequest(args);
  const agentId = optionalString(args, "agentId");
  if (options.requireAgentId && !agentId) {
    throw new Error("Expected non-empty string argument: agentId");
  }
  if (agentId) {
    request.agentId = requireAgentId({ agentId }, "agentId");
  }
  const ruleId = optionalString(args, "ruleId");
  if (ruleId) {
    request.ruleId = ruleId;
  }
  return request;
}

function ipTimelineRequest(args: Record<string, unknown>) {
  const ip = requireIp(args, "ip");
  const direction = optionalString(args, "direction") ?? "any";
  if (!["any", "source", "destination"].includes(direction)) {
    throw new Error("direction must be one of any, source, or destination");
  }
  const request = timelineRequest(args);
  if (direction === "source") {
    request.sourceIp = ip;
  } else if (direction === "destination") {
    request.destinationIp = ip;
  } else {
    request.relatedIp = ip;
  }
  return request;
}

function serviceFinderRequest(args: Record<string, unknown>) {
  const port = optionalNumber(args, "port");
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65_535)) {
    throw new Error("port must be an integer from 1 to 65535");
  }
  const agentLimit = optionalNumber(args, "agentLimit") ?? 50;
  if (!Number.isInteger(agentLimit) || agentLimit < 1 || agentLimit > 200) {
    throw new Error("agentLimit must be an integer from 1 to 200");
  }
  const portLimit = optionalNumber(args, "portLimit") ?? 100;
  if (!Number.isInteger(portLimit) || portLimit < 1 || portLimit > 500) {
    throw new Error("portLimit must be an integer from 1 to 500");
  }
  const request: {
    port?: number;
    service?: string;
    protocol?: string;
    status?: string;
    agentLimit: number;
    portLimit: number;
  } = {
    agentLimit,
    portLimit
  };
  if (port !== undefined) {
    request.port = port;
  }
  const service = optionalString(args, "service");
  if (service) {
    request.service = service;
  }
  const protocol = optionalString(args, "protocol");
  if (protocol) {
    request.protocol = protocol;
  }
  const status = optionalString(args, "status");
  if (status) {
    request.status = status;
  }
  return request;
}

function hostNeighborsRequest(args: Record<string, unknown>) {
  return {
    agentId: requireAgentId(args, "agentId"),
    agentLimit: boundedInteger(args, "agentLimit", 50, 1, 200),
    timeWindowMinutes: boundedInteger(args, "timeWindowMinutes", 60, 1, 10_080),
    alertLimit: boundedInteger(args, "alertLimit", 25, 1, 200)
  };
}

function lateralSuspectsRequest(args: Record<string, unknown>) {
  return {
    timeWindowMinutes: boundedInteger(args, "timeWindowMinutes", 60, 1, 10_080),
    limit: boundedInteger(args, "limit", 100, 1, 200),
    agentLimit: boundedInteger(args, "agentLimit", 100, 1, 200)
  };
}

function lateralPathRequest(args: Record<string, unknown>) {
  const sourceIp = optionalIp(args, "sourceIp");
  const targetIp = optionalIp(args, "targetIp");
  const agentId = optionalString(args, "agentId");
  const request: {
    sourceIp?: string;
    targetIp?: string;
    agentId?: string;
    timeWindowMinutes: number;
    limit: number;
  } = {
    timeWindowMinutes: boundedInteger(args, "timeWindowMinutes", 60, 1, 10_080),
    limit: boundedInteger(args, "limit", 100, 1, 200)
  };
  if (sourceIp) {
    request.sourceIp = sourceIp;
  }
  if (targetIp) {
    request.targetIp = targetIp;
  }
  if (agentId) {
    request.agentId = requireAgentId({ agentId }, "agentId");
  }
  return request;
}

function boundedAlertRequest(args: Record<string, unknown>): {
  timeWindowMinutes: number;
  limit: number;
  agentId?: string;
  ruleId?: string;
  relatedIp?: string;
  sourceIp?: string;
  destinationIp?: string;
} {
  return {
    timeWindowMinutes: boundedInteger(args, "timeWindowMinutes", 60, 1, 10_080),
    limit: boundedInteger(args, "limit", 25, 1, 200)
  };
}

function blockIpRequest(args: Record<string, unknown>, client: WazuhClient) {
  const ip = requireString(args, "ip");
  if (isIP(ip) === 0) {
    throw new Error("ip must be a valid IPv4 or IPv6 address");
  }
  const agentIds = requireStringArray(args, "agentIds").map((agentId) => requireAgentId({ agentId }, "agentId"));
  if (agentIds.length === 0) {
    throw new Error("agentIds must contain at least one Wazuh agent id");
  }
  const command = requireString(args, "command");
  const allowed = client.allowedBlockIpCommands();
  if (!allowed.includes(command)) {
    throw new Error(`Wazuh Active Response command "${command}" is not allowed`);
  }
  const durationSeconds = requireNumber(args, "durationSeconds");
  if (!Number.isInteger(durationSeconds) || durationSeconds <= 0 || durationSeconds > client.maxBlockDurationSeconds()) {
    throw new Error(`durationSeconds must be an integer from 1 to ${client.maxBlockDurationSeconds()}`);
  }
  const reason = requireString(args, "reason");
  return {
    ip,
    agentIds,
    command,
    durationSeconds,
    reason
  };
}

function requireAgentId(args: Record<string, unknown>, key: string): string {
  const value = requireString(args, key);
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error(`${key} must contain only letters, numbers, dot, underscore, or dash`);
  }
  return value;
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Expected non-empty string argument: ${key}`);
  }
  return value.trim();
}

function requireIp(args: Record<string, unknown>, key: string): string {
  const value = requireString(args, key);
  if (isIP(value) === 0) {
    throw new Error(`${key} must be a valid IPv4 or IPv6 address`);
  }
  return value;
}

function optionalIp(args: Record<string, unknown>, key: string): string | undefined {
  const value = optionalString(args, key);
  if (value && isIP(value) === 0) {
    throw new Error(`${key} must be a valid IPv4 or IPv6 address`);
  }
  return value;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim().length ? value.trim() : undefined;
}

function requireStringArray(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Expected string array argument: ${key}`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function requireNumber(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Expected numeric argument: ${key}`);
  }
  return value;
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function boundedInteger(args: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const value = optionalNumber(args, key) ?? fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${key} must be an integer from ${min} to ${max}`);
  }
  return value;
}
