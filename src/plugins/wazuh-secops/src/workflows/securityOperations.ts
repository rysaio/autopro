import type { WazuhIndexerClient } from "../core/indexerClient.js";
import type { WazuhClient } from "../core/wazuhClient.js";
import { affectedItems, agentSummary, alertHits, alertSummary, alertTotal, netaddrSummary, portSummary, totalItems } from "../tools/helpers.js";

export interface NetworkExposureMapRequest {
  status?: string;
  agentLimit: number;
  portLimit: number;
}

export interface RuleHitsSummaryRequest {
  timeWindowMinutes: number;
  limit: number;
  minimumLevel?: number;
}

export async function networkExposureMap(
  client: WazuhClient,
  request: NetworkExposureMapRequest
): Promise<Record<string, unknown>> {
  const agentsResponse = await client.listAgents({ status: request.status, limit: request.agentLimit });
  const agents = affectedItems(agentsResponse);
  const exposures: Record<string, unknown>[] = [];
  const networks = new Map<string, { network: string; agents: Set<string>; addresses: Set<string> }>();
  const services = new Map<string, { serviceKey: string; protocol?: string; port?: number; agents: Set<string>; bindings: Record<string, unknown>[] }>();
  const errors: Record<string, unknown>[] = [];

  for (const agent of agents) {
    const summary = agentSummary(agent);
    const agentId = typeof summary.id === "string" || typeof summary.id === "number" ? String(summary.id) : undefined;
    if (!agentId) {
      continue;
    }
    try {
      const [addressesResponse, portsResponse] = await Promise.all([
        client.listSyscollector(agentId, "netaddr", { limit: 100 }),
        client.listSyscollector(agentId, "ports", { limit: request.portLimit, q: "state=LISTEN" })
      ]);
      const addresses = affectedItems(addressesResponse).map(netaddrSummary);
      const ports = affectedItems(portsResponse).map(portSummary);
      const networkItems = addresses.map(networkFromAddress).filter((item): item is NetworkAddress => Boolean(item));
      for (const item of networkItems) {
        const bucket = networks.get(item.network) ?? { network: item.network, agents: new Set<string>(), addresses: new Set<string>() };
        bucket.agents.add(agentId);
        bucket.addresses.add(item.address);
        networks.set(item.network, bucket);
      }
      for (const port of ports) {
        const serviceKey = `${String(port.protocol ?? "unknown").toLowerCase()}:${String(port.localPort ?? "unknown")}`;
        const protocol = typeof port.protocol === "string" ? port.protocol : undefined;
        const localPort = typeof port.localPort === "number" ? port.localPort : undefined;
        const bucket = services.get(serviceKey) ?? { serviceKey, agents: new Set<string>(), bindings: [] };
        if (protocol) {
          bucket.protocol = protocol;
        }
        if (localPort !== undefined) {
          bucket.port = localPort;
        }
        bucket.agents.add(agentId);
        bucket.bindings.push({
          agent: summary,
          port,
          addresses,
          evidenceType: "direct-syscollector-listening-port"
        });
        services.set(serviceKey, bucket);
      }
      exposures.push({
        agent: summary,
        addresses,
        listeningPorts: ports,
        evidenceType: "direct-syscollector-exposure"
      });
    } catch (error) {
      errors.push({ agent: summary, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return {
    endpointClass: "wazuh.syscollector.network-exposure-map",
    filters: request,
    scannedAgents: agents.length,
    totalAgents: totalItems(agentsResponse) ?? agents.length,
    directEvidence: exposures,
    networks: [...networks.values()].map((item) => ({
      network: item.network,
      agentIds: [...item.agents].sort(),
      addresses: [...item.addresses].sort()
    })),
    services: [...services.values()].map((item) => ({
      serviceKey: item.serviceKey,
      protocol: item.protocol,
      port: item.port,
      agentIds: [...item.agents].sort(),
      bindings: item.bindings
    })),
    errors
  };
}

export async function ruleHitsSummary(
  indexer: WazuhIndexerClient,
  request: RuleHitsSummaryRequest
): Promise<Record<string, unknown>> {
  const response = await indexer.searchAlerts({
    timeWindowMinutes: request.timeWindowMinutes,
    limit: request.limit
  });
  const alerts = alertHits(response).map(enrichedRuleAlert).filter((alert) => {
    if (request.minimumLevel === undefined) {
      return true;
    }
    const level = recordField(alert, "rule").level;
    return typeof level === "number" && level >= request.minimumLevel;
  });
  const counts = new Map<string, RuleHitBucket>();
  for (const alert of alerts) {
    const rule = recordField(alert, "rule");
    const ruleId = typeof rule.id === "string" ? rule.id : "unknown";
    const bucket = counts.get(ruleId) ?? {
      ruleId,
      count: 0,
      agents: new Set<string>(),
      groups: new Set<string>()
    };
    if (typeof rule.level === "number") {
      bucket.level = rule.level;
    }
    if (typeof rule.description === "string") {
      bucket.description = rule.description;
    }
    bucket.count += 1;
    const agent = recordField(alert, "agent");
    if (typeof agent.id === "string") {
      bucket.agents.add(agent.id);
    }
    const groups = Array.isArray(alert.ruleGroups) ? alert.ruleGroups : [];
    for (const group of groups) {
      if (typeof group === "string") {
        bucket.groups.add(group);
      }
    }
    counts.set(ruleId, bucket);
  }

  return {
    endpointClass: "wazuh.indexer.rule-hits-summary",
    endpointHost: indexer.endpointHost(),
    index: indexer.alertsIndex(),
    filters: request,
    totalAlerts: alertTotal(response) ?? alerts.length,
    directEvidence: alerts,
    ruleHits: [...counts.values()]
      .map((item) => ({
        ruleId: item.ruleId,
        level: item.level,
        description: item.description,
        count: item.count,
        agentIds: [...item.agents].sort(),
        groups: [...item.groups].sort()
      }))
      .sort((left, right) => right.count - left.count)
  };
}

interface NetworkAddress {
  address: string;
  network: string;
}

interface RuleHitBucket {
  ruleId: string;
  level?: number;
  description?: string;
  count: number;
  agents: Set<string>;
  groups: Set<string>;
}

function enrichedRuleAlert(value: unknown): Record<string, unknown> {
  const summary = alertSummary(value);
  const source = alertSource(value);
  const rule = recordField(source, "rule");
  return {
    ...summary,
    ruleGroups: Array.isArray(rule.groups) ? rule.groups : undefined,
    evidenceType: "direct-wazuh-alert"
  };
}

function networkFromAddress(value: Record<string, unknown>): NetworkAddress | undefined {
  if (typeof value.address !== "string" || typeof value.netmask !== "string") {
    return undefined;
  }
  const network = networkCidr(value.address, value.netmask);
  return network ? { address: value.address, network } : undefined;
}

function networkCidr(address: string, netmask: string): string | undefined {
  const ip = ipv4ToInt(address);
  const mask = ipv4ToInt(netmask);
  if (ip === undefined || mask === undefined) {
    return undefined;
  }
  const prefix = mask.toString(2).split("1").length - 1;
  const network = intToIpv4((ip & mask) >>> 0);
  return `${network}/${prefix}`;
}

function ipv4ToInt(value: string): number | undefined {
  const parts = value.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return undefined;
  }
  const [first, second, third, fourth] = parts as [number, number, number, number];
  return (((first * 256 + second) * 256 + third) * 256 + fourth) >>> 0;
}

function intToIpv4(value: number): string {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join(".");
}

function alertSource(value: unknown): Record<string, unknown> {
  if (isRecord(value) && isRecord(value._source)) {
    return value._source;
  }
  return isRecord(value) ? value : {};
}

function recordField(value: unknown, key: string): Record<string, unknown> {
  return isRecord(value) && isRecord(value[key]) ? value[key] : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
