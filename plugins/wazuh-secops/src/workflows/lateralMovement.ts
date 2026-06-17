import { isIP } from "node:net";
import type { WazuhAlertSearchInput, WazuhIndexerClient } from "../core/indexerClient.js";
import type { WazuhClient } from "../core/wazuhClient.js";
import {
  affectedItems,
  agentSummary,
  alertHits,
  alertSummary,
  alertTotal,
  netaddrSummary,
  portSummary,
  totalItems
} from "../tools/helpers.js";

export interface TimelineRequest {
  agentId?: string;
  relatedIp?: string;
  sourceIp?: string;
  destinationIp?: string;
  ruleId?: string;
  timeWindowMinutes: number;
  limit: number;
}

export interface ServiceFinderRequest {
  port?: number;
  service?: string;
  protocol?: string;
  status?: string;
  agentLimit: number;
  portLimit: number;
}

export interface HostNeighborsRequest {
  agentId: string;
  agentLimit: number;
  timeWindowMinutes: number;
  alertLimit: number;
}

export interface LateralSuspectsRequest {
  timeWindowMinutes: number;
  limit: number;
  agentLimit: number;
}

export interface LateralPathRequest {
  sourceIp?: string;
  targetIp?: string;
  agentId?: string;
  timeWindowMinutes: number;
  limit: number;
}

export async function agentAlertTimeline(indexer: WazuhIndexerClient, request: TimelineRequest): Promise<Record<string, unknown>> {
  const response = await indexer.searchAlerts(toAlertSearchInput(request));
  const alerts = alertHits(response).map(enrichedAlertSummary);
  return {
    endpointClass: "wazuh.indexer.agent-alerts-timeline",
    endpointHost: indexer.endpointHost(),
    index: indexer.alertsIndex(),
    count: alerts.length,
    total: alertTotal(response) ?? alerts.length,
    filters: request,
    directEvidence: alerts,
    raw: response
  };
}

export async function ipActivityTimeline(indexer: WazuhIndexerClient, request: TimelineRequest): Promise<Record<string, unknown>> {
  const response = await indexer.searchAlerts(toAlertSearchInput(request));
  const alerts = alertHits(response).map(enrichedAlertSummary);
  return {
    endpointClass: "wazuh.indexer.ip-activity-timeline",
    endpointHost: indexer.endpointHost(),
    index: indexer.alertsIndex(),
    count: alerts.length,
    total: alertTotal(response) ?? alerts.length,
    filters: request,
    directEvidence: alerts,
    inferredCorrelations: summarizeIpRelationships(alerts),
    raw: response
  };
}

export async function networkServiceFind(client: WazuhClient, request: ServiceFinderRequest): Promise<Record<string, unknown>> {
  if (request.port === undefined && !request.service) {
    throw new Error("Either port or service is required");
  }
  const agentsResponse = await client.listAgents({ status: request.status, limit: request.agentLimit });
  const agents = affectedItems(agentsResponse);
  const matches: Record<string, unknown>[] = [];
  const errors: Record<string, unknown>[] = [];

  for (const agent of agents) {
    const summary = agentSummary(agent);
    const agentId = typeof summary.id === "string" || typeof summary.id === "number" ? String(summary.id) : undefined;
    if (!agentId) {
      continue;
    }
    try {
      const portsResponse = await client.listSyscollector(agentId, "ports", {
        limit: request.portLimit,
        q: request.port === undefined ? undefined : `local_port=${request.port}`
      });
      const ports = affectedItems(portsResponse).map(portSummary).filter((port) => serviceMatches(port, request));
      for (const port of ports) {
        matches.push({
          agent: summary,
          port,
          evidenceType: "direct-syscollector-port"
        });
      }
    } catch (error) {
      errors.push({ agent: summary, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return {
    endpointClass: "wazuh.syscollector.network-service-find",
    filters: request,
    scannedAgents: agents.length,
    totalAgents: totalItems(agentsResponse) ?? agents.length,
    matches,
    errors
  };
}

export async function hostNeighbors(
  client: WazuhClient,
  indexer: WazuhIndexerClient,
  request: HostNeighborsRequest
): Promise<Record<string, unknown>> {
  const targetAddresses = await collectAgentAddresses(client, request.agentId);
  const agentsResponse = await client.listAgents({ limit: request.agentLimit });
  const agents = affectedItems(agentsResponse);
  const directEvidence: Record<string, unknown>[] = [];
  const errors: Record<string, unknown>[] = [];

  for (const agent of agents) {
    const summary = agentSummary(agent);
    const agentId = typeof summary.id === "string" || typeof summary.id === "number" ? String(summary.id) : undefined;
    if (!agentId || agentId === request.agentId) {
      continue;
    }
    try {
      const addresses = await collectAgentAddresses(client, agentId);
      const sharedNetworks = sharedNetworkEvidence(targetAddresses.addresses, addresses.addresses);
      if (sharedNetworks.length) {
        directEvidence.push({
          neighbor: summary,
          evidenceType: "direct-shared-syscollector-network",
          sharedNetworks
        });
      }
    } catch (error) {
      errors.push({ agent: summary, error: error instanceof Error ? error.message : String(error) });
    }
  }

  const alertsResponse = await indexer.searchAlerts({
    agentId: request.agentId,
    timeWindowMinutes: request.timeWindowMinutes,
    limit: request.alertLimit
  });
  const alerts = alertHits(alertsResponse).map(enrichedAlertSummary);
  const knownAgentIps = new Map<string, Record<string, unknown>>();
  for (const agent of agents) {
    const summary = agentSummary(agent);
    if (typeof summary.ip === "string" && isIP(summary.ip)) {
      knownAgentIps.set(summary.ip, summary);
    }
  }
  const inferredCorrelations = alerts
    .flatMap((alert) => [alert.sourceIp, alert.destinationIp].filter((ip): ip is string => typeof ip === "string"))
    .filter((ip) => knownAgentIps.has(ip))
    .map((ip) => ({
      relatedAgent: knownAgentIps.get(ip),
      relatedIp: ip,
      inference: "alert references another known Wazuh agent IP; confirm direction and causality from raw alert context"
    }));

  return {
    endpointClass: "wazuh.lateral.host-neighbors",
    agentId: request.agentId,
    filters: request,
    targetAddresses: targetAddresses.summaries,
    directEvidence,
    inferredCorrelations: uniqueByJson(inferredCorrelations),
    alertSample: alerts,
    errors
  };
}

export async function lateralSuspects(
  client: WazuhClient,
  indexer: WazuhIndexerClient,
  request: LateralSuspectsRequest
): Promise<Record<string, unknown>> {
  const response = await indexer.searchAlerts({
    timeWindowMinutes: request.timeWindowMinutes,
    limit: request.limit
  });
  const alerts = alertHits(response).map(enrichedAlertSummary);
  const agentMap = await collectAgentIpMap(client, request.agentLimit);
  const scored = new Map<string, { score: number; reasons: string[]; evidence: Record<string, unknown>[] }>();

  for (const alert of alerts) {
    const sourceIp = typeof alert.sourceIp === "string" ? alert.sourceIp : undefined;
    if (!sourceIp || !isInternalIp(sourceIp)) {
      continue;
    }
    const reasons = lateralSignals(alert);
    if (!reasons.length) {
      continue;
    }
    const current = scored.get(sourceIp) ?? { score: 0, reasons: [], evidence: [] };
    current.score += reasons.length;
    current.reasons.push(...reasons);
    current.evidence.push(alert);
    scored.set(sourceIp, current);
  }

  const suspects = [...scored.entries()]
    .map(([sourceIp, value]) => ({
      sourceIp,
      mappedAgent: agentMap.get(sourceIp),
      score: value.score,
      reasons: [...new Set(value.reasons)],
      directEvidence: value.evidence.slice(0, 10),
      inference: "internal source IP with repeated Wazuh lateral-movement indicators; validate with endpoint and network context"
    }))
    .sort((left, right) => right.score - left.score);

  return {
    endpointClass: "wazuh.lateral.suspects",
    filters: request,
    totalAlerts: alertTotal(response) ?? alerts.length,
    directEvidence: alerts,
    inferredCorrelations: suspects,
    unmappedInternalSources: suspects.filter((item) => !item.mappedAgent).map((item) => item.sourceIp)
  };
}

export async function lateralPathSummary(indexer: WazuhIndexerClient, request: LateralPathRequest): Promise<Record<string, unknown>> {
  if (!request.sourceIp && !request.targetIp && !request.agentId) {
    throw new Error("At least one of sourceIp, targetIp, or agentId is required");
  }
  const query: WazuhAlertSearchInput = {
    timeWindowMinutes: request.timeWindowMinutes,
    limit: request.limit
  };
  const relatedIp = request.sourceIp ?? request.targetIp;
  if (relatedIp) {
    query.relatedIp = relatedIp;
  }
  if (request.agentId) {
    query.agentId = request.agentId;
  }
  const response = await indexer.searchAlerts(query);
  const alerts = alertHits(response).map(enrichedAlertSummary);
  const matchingAlerts = alerts.filter((alert) => alertMatchesPath(alert, request));
  const paths = summarizeAlertPaths(matchingAlerts);

  return {
    endpointClass: "wazuh.lateral.path-summary",
    filters: request,
    count: matchingAlerts.length,
    total: alertTotal(response) ?? alerts.length,
    directEvidence: matchingAlerts,
    inferredCorrelations: paths.map((path) => ({
      ...path,
      inference: "source-to-target relationship inferred from Wazuh alert IP fields; confirm protocol/session causality before containment"
    })),
    raw: response
  };
}

function toAlertSearchInput(request: TimelineRequest): WazuhAlertSearchInput {
  const input: WazuhAlertSearchInput = {
    timeWindowMinutes: request.timeWindowMinutes,
    limit: request.limit
  };
  if (request.relatedIp) {
    input.relatedIp = request.relatedIp;
  }
  if (request.sourceIp) {
    input.sourceIp = request.sourceIp;
  }
  if (request.destinationIp) {
    input.destinationIp = request.destinationIp;
  }
  if (request.agentId) {
    input.agentId = request.agentId;
  }
  if (request.ruleId) {
    input.ruleId = request.ruleId;
  }
  return input;
}

function enrichedAlertSummary(value: unknown): Record<string, unknown> {
  const summary = alertSummary(value);
  const source = alertSource(value);
  const data = recordField(source, "data");
  const rule = recordField(source, "rule");
  return {
    ...summary,
    sourceIp: stringFrom(data.srcip, data.src_ip, recordField(source, "source").ip, source.srcip, summary.sourceIp),
    destinationIp: stringFrom(data.dstip, data.dst_ip, recordField(source, "destination").ip, source.dstip),
    user: stringFrom(data.dstuser, data.srcuser, data.user, source.user),
    ruleGroups: Array.isArray(rule.groups) ? rule.groups : undefined,
    decoder: recordField(source, "decoder").name,
    evidenceType: "direct-wazuh-alert"
  };
}

function summarizeIpRelationships(alerts: Record<string, unknown>[]): Record<string, unknown>[] {
  return summarizeAlertPaths(alerts).map((path) => ({
    ...path,
    inference: "IP relationship inferred from source/destination fields in one or more Wazuh alerts"
  }));
}

function summarizeAlertPaths(alerts: Record<string, unknown>[]): Array<Record<string, unknown>> {
  const counts = new Map<string, { sourceIp: string; destinationIp: string; count: number; rules: Set<string> }>();
  for (const alert of alerts) {
    const sourceIp = typeof alert.sourceIp === "string" ? alert.sourceIp : undefined;
    const destinationIp = typeof alert.destinationIp === "string" ? alert.destinationIp : undefined;
    if (!sourceIp || !destinationIp) {
      continue;
    }
    const key = `${sourceIp}->${destinationIp}`;
    const item = counts.get(key) ?? { sourceIp, destinationIp, count: 0, rules: new Set<string>() };
    item.count += 1;
    const rule = recordField(alert, "rule");
    if (typeof rule.id === "string") {
      item.rules.add(rule.id);
    }
    counts.set(key, item);
  }
  return [...counts.values()]
    .map((item) => ({
      sourceIp: item.sourceIp,
      destinationIp: item.destinationIp,
      alertCount: item.count,
      ruleIds: [...item.rules]
    }))
    .sort((left, right) => Number(right.alertCount) - Number(left.alertCount));
}

function serviceMatches(port: Record<string, unknown>, request: ServiceFinderRequest): boolean {
  if (request.protocol && String(port.protocol ?? "").toLowerCase() !== request.protocol.toLowerCase()) {
    return false;
  }
  if (request.port !== undefined && Number(port.localPort) !== request.port) {
    return false;
  }
  if (request.service) {
    const haystack = `${port.process ?? ""} ${port.localPort ?? ""}`.toLowerCase();
    return haystack.includes(request.service.toLowerCase());
  }
  return true;
}

async function collectAgentAddresses(client: WazuhClient, agentId: string): Promise<{
  summaries: Record<string, unknown>[];
  addresses: AgentAddress[];
}> {
  const response = await client.listSyscollector(agentId, "netaddr", { limit: 100 });
  const summaries = affectedItems(response).map(netaddrSummary);
  return {
    summaries,
    addresses: summaries.map((item) => toAgentAddress(agentId, item)).filter((item): item is AgentAddress => Boolean(item))
  };
}

async function collectAgentIpMap(client: WazuhClient, limit: number): Promise<Map<string, Record<string, unknown>>> {
  const response = await client.listAgents({ limit });
  const map = new Map<string, Record<string, unknown>>();
  for (const agent of affectedItems(response)) {
    const summary = agentSummary(agent);
    if (typeof summary.ip === "string" && isIP(summary.ip)) {
      map.set(summary.ip, summary);
    }
  }
  return map;
}

interface AgentAddress {
  agentId: string;
  iface?: string;
  address: string;
  netmask?: string;
  network?: string;
}

function toAgentAddress(agentId: string, value: Record<string, unknown>): AgentAddress | undefined {
  if (typeof value.address !== "string" || isIP(value.address) === 0) {
    return undefined;
  }
  const netmask = typeof value.netmask === "string" ? value.netmask : undefined;
  const address: AgentAddress = {
    agentId,
    address: value.address
  };
  if (typeof value.iface === "string") {
    address.iface = value.iface;
  }
  if (netmask) {
    address.netmask = netmask;
    const network = networkCidr(value.address, netmask);
    if (network) {
      address.network = network;
    }
  }
  return address;
}

function sharedNetworkEvidence(left: AgentAddress[], right: AgentAddress[]): Record<string, unknown>[] {
  const evidence: Record<string, unknown>[] = [];
  for (const leftAddress of left) {
    for (const rightAddress of right) {
      if (leftAddress.network && leftAddress.network === rightAddress.network) {
        evidence.push({
          network: leftAddress.network,
          targetAddress: leftAddress.address,
          neighborAddress: rightAddress.address,
          targetInterface: leftAddress.iface,
          neighborInterface: rightAddress.iface
        });
      }
    }
  }
  return evidence;
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

function lateralSignals(alert: Record<string, unknown>): string[] {
  const text = JSON.stringify(alert).toLowerCase();
  const reasons: string[] = [];
  if (text.includes("sshd") || text.includes("ssh")) {
    reasons.push("ssh-related alert");
  }
  if (text.includes("authentication") || text.includes("failed") || text.includes("invalid user")) {
    reasons.push("authentication failure indicator");
  }
  if (text.includes("sudo") || text.includes("privilege") || text.includes("root")) {
    reasons.push("privilege escalation indicator");
  }
  if (text.includes("remote") || text.includes("lateral") || text.includes("pivot")) {
    reasons.push("remote access or lateral movement wording");
  }
  return reasons;
}

function alertMatchesPath(alert: Record<string, unknown>, request: LateralPathRequest): boolean {
  const sourceMatches = !request.sourceIp || alert.sourceIp === request.sourceIp;
  const targetMatches = !request.targetIp || alert.destinationIp === request.targetIp || recordField(alert, "agent").ip === request.targetIp;
  return sourceMatches && targetMatches;
}

function isInternalIp(value: string): boolean {
  if (value.startsWith("10.") || value.startsWith("192.168.")) {
    return true;
  }
  const match = /^172\.(\d+)\./.exec(value);
  if (match) {
    const second = Number(match[1]);
    return second >= 16 && second <= 31;
  }
  return value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe80:");
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

function stringFrom(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function uniqueByJson<T>(items: T[]): T[] {
  const seen = new Set<string>();
  const output: T[] = [];
  for (const item of items) {
    const key = JSON.stringify(item);
    if (!seen.has(key)) {
      seen.add(key);
      output.push(item);
    }
  }
  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
