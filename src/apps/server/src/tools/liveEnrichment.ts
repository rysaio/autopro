import { lookup as dnsLookup, resolve4, resolve6, resolveMx, resolveTxt, reverse as dnsReverse } from "node:dns/promises";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// ============================================================
// Live enrichment helpers for the SecOps triage tools.
//
// The goal is to make the core triage tools perform real network
// lookups against public, no-configuration sources (DNS, ipinfo.io,
// AlienVault OTX, GreyNoise, CIRCL hashlookup, attack.mitre.org, and
// the public SigmaHQ rule tree) while always retaining the local
// knowledge base as a deterministic fallback. Results are cached in
// <workspaceRoot>/runtime/knowledge/secops-live-knowledge.json so a
// subsequent call can use fresh local data without leaving the host.
// ============================================================

const DEFAULT_HTTP_TIMEOUT_MS = 2_500;
const DEFAULT_MAX_BYTES = 1_000_000;
const IP_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const MITRE_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const KNOWLEDGE_DIR_NAME = path.join("runtime", "knowledge");
const KNOWLEDGE_FILE_NAME = "secops-live-knowledge.json";

export interface LiveProbe {
  source: string;
  status: "ok" | "error" | "timeout" | "skipped";
  latencyMs: number;
  data?: unknown;
  error?: string;
}

export interface LiveReport {
  status: "online" | "offline" | "skipped";
  checkedAt: string;
  probes: LiveProbe[];
}

export interface LiveAssessment {
  found: boolean;
  source: string;
  category: string;
  severity: "critical" | "high" | "medium" | "low";
  description: string;
  firstSeen?: string;
  tags: string[];
}

export interface LiveThreatIntelResult {
  report: LiveReport;
  assessment: LiveAssessment | null;
  data: Record<string, unknown> | null;
  fromCache: boolean;
}

export interface LiveMitreTechniqueResult {
  report: LiveReport;
  technique: {
    name?: string;
    description?: string;
    url?: string;
    raw?: string;
  } | null;
  fromCache: boolean;
}

interface KnowledgeCacheEntry {
  fetchedAt: string;
  data: unknown;
}

interface KnowledgeCacheFile {
  version: 1;
  updatedAt: string;
  entries: Record<string, KnowledgeCacheEntry>;
}

const memoryCache = new Map<string, KnowledgeCacheFile>();
const writeQueues = new Map<string, Promise<void>>();

// ============================================================
// Cache helpers
// ============================================================

function cachePathFor(workspaceRoot: string): string {
  return path.join(workspaceRoot, KNOWLEDGE_DIR_NAME, KNOWLEDGE_FILE_NAME);
}

async function readCache(workspaceRoot: string): Promise<KnowledgeCacheFile> {
  const cachePath = cachePathFor(workspaceRoot);
  const existing = memoryCache.get(cachePath);
  if (existing) {
    return existing;
  }
  let file: KnowledgeCacheFile = { version: 1, updatedAt: new Date(0).toISOString(), entries: {} };
  try {
    const raw = await readFile(cachePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<KnowledgeCacheFile>;
    if (parsed && parsed.version === 1 && parsed.entries && typeof parsed.entries === "object") {
      file = {
        version: 1,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
        entries: parsed.entries as Record<string, KnowledgeCacheEntry>
      };
    }
  } catch {
    // Missing or corrupt cache is not fatal; we simply start empty.
  }
  memoryCache.set(cachePath, file);
  return file;
}

async function writeCache(workspaceRoot: string, file: KnowledgeCacheFile): Promise<void> {
  const cachePath = cachePathFor(workspaceRoot);
  memoryCache.set(cachePath, file);
  const previous = writeQueues.get(cachePath) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      await mkdir(path.dirname(cachePath), { recursive: true });
      await writeFile(cachePath, JSON.stringify(file, null, 2), "utf8");
    });
  writeQueues.set(cachePath, next);
  try {
    await next;
  } catch {
    // Cache persistence must never break tool execution.
  } finally {
    if (writeQueues.get(cachePath) === next) {
      writeQueues.delete(cachePath);
    }
  }
}

async function getCached(workspaceRoot: string, key: string, ttlMs: number): Promise<unknown | null> {
  const file = await readCache(workspaceRoot);
  const entry = file.entries[key];
  if (!entry || typeof entry.fetchedAt !== "string") {
    return null;
  }
  const fetchedAt = Date.parse(entry.fetchedAt);
  if (!Number.isFinite(fetchedAt) || Date.now() - fetchedAt > ttlMs) {
    return null;
  }
  return entry.data;
}

async function setCached(workspaceRoot: string, key: string, data: unknown): Promise<void> {
  const file = await readCache(workspaceRoot);
  file.entries[key] = {
    fetchedAt: new Date().toISOString(),
    data
  };
  file.updatedAt = new Date().toISOString();
  await writeCache(workspaceRoot, file);
}

// ============================================================
// Network helpers
// ============================================================

async function runProbe(source: string, task: () => Promise<unknown>, timeoutMs = DEFAULT_HTTP_TIMEOUT_MS): Promise<LiveProbe> {
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const data = await Promise.race([
      task(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
    return {
      source,
      status: "ok",
      latencyMs: Date.now() - startedAt,
      ...(data !== undefined ? { data } : {})
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const timedOut = /timed out|abort/i.test(message);
    return {
      source,
      status: timedOut ? "timeout" : "error",
      latencyMs: Date.now() - startedAt,
      ...(message ? { error: message } : {})
    };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function skippedProbe(source: string, reason: string): LiveProbe {
  return { source, status: "skipped", latencyMs: 0, error: reason };
}

function reportFrom(probes: LiveProbe[]): LiveReport {
  const checkedAt = new Date().toISOString();
  if (probes.length === 0 || probes.every((probe) => probe.status === "skipped")) {
    return { status: "skipped", checkedAt, probes };
  }
  if (probes.some((probe) => probe.status === "ok")) {
    return { status: "online", checkedAt, probes };
  }
  return { status: "offline", checkedAt, probes };
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = DEFAULT_HTTP_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal, redirect: "follow" });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url: string, init: RequestInit = {}, timeoutMs = DEFAULT_HTTP_TIMEOUT_MS): Promise<unknown> {
  const response = await fetchWithTimeout(url, init, timeoutMs);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  const text = await response.text();
  if (text.length > DEFAULT_MAX_BYTES) {
    throw new Error(`Response too large (${text.length} bytes) for ${url}`);
  }
  return JSON.parse(text) as unknown;
}

async function fetchText(url: string, timeoutMs = DEFAULT_HTTP_TIMEOUT_MS): Promise<string> {
  const response = await fetchWithTimeout(url, {}, timeoutMs);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  const text = await response.text();
  if (text.length > DEFAULT_MAX_BYTES) {
    throw new Error(`Response too large (${text.length} bytes) for ${url}`);
  }
  return text;
}

async function probeOtxGeneral(indicatorType: "IPv4" | "domain" | "url", indicator: string): Promise<unknown> {
  return fetchJson(`https://otx.alienvault.com/api/v1/indicators/${indicatorType}/${encodeURIComponent(indicator)}/general`, {
    headers: {
      Accept: "application/json",
      "User-Agent": "secops-agent-live-enrichment"
    }
  });
}

async function probeGreyNoiseCommunity(ip: string): Promise<unknown> {
  return fetchJson(`https://api.greynoise.io/v3/community/${encodeURIComponent(ip)}`, {
    headers: {
      Accept: "application/json",
      "User-Agent": "secops-agent-live-enrichment"
    }
  });
}

async function probeHashlookup(hash: string): Promise<unknown> {
  const algorithm = hash.length === 32 ? "md5" : hash.length === 40 ? "sha1" : hash.length === 64 ? "sha256" : null;
  if (!algorithm) {
    throw new Error(`Unsupported hash length for CIRCL hashlookup: ${hash.length}`);
  }
  return fetchJson(`https://hashlookup.circl.lu/lookup/${algorithm}/${encodeURIComponent(hash)}`, {
    headers: {
      Accept: "application/json",
      "User-Agent": "secops-agent-live-enrichment"
    }
  });
}

// ============================================================
// Indicator classification helpers
// ============================================================

export function isDocumentationIp(ip: string): boolean {
  return /^(192\.0\.2|198\.51\.100|203\.0\.113)\./.test(ip);
}

export function isPrivateIp(ip: string): boolean {
  return /^(10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|0\.)/.test(ip) ||
    ip === "::1" || ip === "::" ||
    /^f[cd][0-9a-f]{2}:/i.test(ip) ||
    /^fe80:/i.test(ip);
}

export function isPublicIp(ip: string): boolean {
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip) && !isPrivateIp(ip) && !isDocumentationIp(ip);
}

export function isDomainLike(value: string): boolean {
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/i.test(value);
}

export function isHashLike(value: string): boolean {
  return /^[a-f0-9]{32,64}$/i.test(value);
}

export function isUrlLike(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

// ============================================================
// ipinfo.io and DNS enrichment
// ============================================================

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function probeIpInfo(ip: string): Promise<LiveProbe> {
  return runProbe("ipinfo.io", () => fetchJson(`https://ipinfo.io/${encodeURIComponent(ip)}/json`, {
    headers: { Accept: "application/json" }
  }));
}

function probeDnsReverse(ip: string): Promise<LiveProbe> {
  return runProbe("dns.reverse", async () => {
    const hostnames = await dnsReverse(ip).catch(() => []);
    if (hostnames.length === 0) {
      throw new Error("No PTR records");
    }
    return hostnames;
  });
}

// ============================================================
// Public threat intel enrichment
// ============================================================

function otxAssessment(source: string, data: unknown): LiveAssessment | null {
  const record = asRecord(data);
  if (!record) {
    return null;
  }
  const pulseInfo = asRecord(record.pulse_info);
  const count = Number(pulseInfo?.count ?? 0);
  if (!Number.isFinite(count) || count <= 0) {
    return null;
  }
  const pulses = Array.isArray(pulseInfo?.pulses) ? pulseInfo?.pulses as Record<string, unknown>[] : [];
  const tags = new Set<string>();
  for (const pulse of pulses) {
    const pulseRecord = asRecord(pulse);
    if (!pulseRecord) continue;
    for (const tag of asArray(pulseRecord.tags)) {
      tags.add(tag);
    }
    if (typeof pulseRecord.name === "string" && pulseRecord.name.length > 0) {
      tags.add(pulseRecord.name);
    }
  }
  return {
    found: true,
    source,
    category: [...tags][0] ?? "threat-intel",
    severity: count >= 20 ? "critical" : count >= 5 ? "high" : "medium",
    description: `AlienVault OTX reports ${count} threat intelligence pulse(s) for this indicator.`,
    tags: [...tags].slice(0, 12)
  };
}

function greyNoiseAssessment(source: string, data: unknown): LiveAssessment | null {
  const record = asRecord(data);
  if (!record || record.noise !== true) {
    return null;
  }
  const classification = typeof record.classification === "string" ? record.classification : "";
  const name = typeof record.name === "string" ? record.name : "";
  return {
    found: true,
    source,
    category: classification === "malicious" ? "malicious" : "internet-background-noise",
    severity: classification === "malicious" ? "medium" : "low",
    description: `GreyNoise observed this IP scanning the internet (classification: ${classification || "unknown"}${name ? `, actor: ${name}` : ""}).`,
    tags: ["greynoise", ...(classification ? [classification] : [])]
  };
}

function hashlookupAssessment(source: string, data: unknown): LiveAssessment | null {
  const record = asRecord(data);
  if (!record || !(typeof record.FileName === "string" || typeof record["SHA-1"] === "string")) {
    return null;
  }
  return {
    found: true,
    source,
    category: "known-file",
    severity: "low",
    description: `CIRCL hashlookup identified this file hash as ${String(record.FileName ?? "known binary")}.`,
    tags: ["hashlookup", "known-file"]
  };
}

function asArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function compactOtx(data: unknown): Record<string, unknown> {
  const record = asRecord(data);
  if (!record) {
    return {};
  }
  const pulseInfo = asRecord(record.pulse_info);
  const pulses = Array.isArray(pulseInfo?.pulses) ? pulseInfo.pulses as Record<string, unknown>[] : [];
  return {
    indicator: record.indicator,
    type: record.type,
    reputation: record.reputation,
    pulseCount: Number(pulseInfo?.count ?? 0),
    topPulses: pulses.slice(0, 5).map((pulse) => ({
      id: pulse.id,
      name: pulse.name,
      tags: asArray(pulse.tags).slice(0, 8)
    }))
  };
}

function compactHashlookup(data: unknown): Record<string, unknown> {
  const record = asRecord(data);
  if (!record) {
    return {};
  }
  const product = asRecord(record.ProductCode);
  return {
    FileName: record.FileName,
    MD5: record.MD5,
    "SHA-1": record["SHA-1"],
    "SHA-256": record["SHA-256"],
    mimetype: record.mimetype,
    source: record.source,
    productName: product?.ProductName
  };
}

function probeSummary(probe: LiveProbe): LiveProbe {
  const summary: LiveProbe = {
    source: probe.source,
    status: probe.status,
    latencyMs: probe.latencyMs
  };
  if (probe.error !== undefined) {
    summary.error = probe.error;
  }
  return summary;
}

export async function liveThreatIntelLookup(indicator: string, workspaceRoot: string): Promise<LiveThreatIntelResult> {
  const normalized = indicator.trim().toLowerCase();
  const cacheKey = `threat-intel:${normalized}`;
  const cached = await getCached(workspaceRoot, cacheKey, IP_CACHE_TTL_MS);
  if (cached) {
    const parsed = asRecord(cached);
    if (parsed && parsed.report) {
      return {
        report: parsed.report as LiveReport,
        assessment: (parsed.assessment as LiveAssessment | null) ?? null,
        data: (parsed.data as Record<string, unknown> | null) ?? null,
        fromCache: true
      };
    }
  }

  let probes: LiveProbe[] = [];
  let assessment: LiveAssessment | null = null;
  let data: Record<string, unknown> | null = null;

  if (isPublicIp(normalized) || isDomainLike(normalized) || isHashLike(normalized) || isUrlLike(normalized)) {
    if (isPublicIp(normalized)) {
      const [ipInfo, reverse, greyNoise, otx] = await Promise.all([
        probeIpInfo(normalized),
        probeDnsReverse(normalized),
        runProbe("greynoise.community", () => probeGreyNoiseCommunity(normalized)),
        runProbe("otx.alienvault", () => probeOtxGeneral("IPv4", normalized))
      ]);
      probes = [ipInfo, reverse, greyNoise, otx];
      const liveData: Record<string, unknown> = {};
      if (ipInfo.status === "ok") {
        liveData.ipinfo = ipInfo.data;
      }
      if (reverse.status === "ok") {
        liveData.reverseHostnames = reverse.data;
      }
      if (greyNoise.status === "ok") {
        liveData.greyNoise = greyNoise.data;
      }
      if (otx.status === "ok") {
        liveData.otx = compactOtx(otx.data);
      }
      data = Object.keys(liveData).length > 0 ? liveData : null;
      assessment = otxAssessment("otx.alienvault", otx.data) ?? greyNoiseAssessment("greynoise.community", greyNoise.data);
    } else if (isDomainLike(normalized)) {
      const [dnsProbe, otx] = await Promise.all([
        runProbe("dns.lookup", async () => ({
          addresses: await dnsLookup(normalized, { all: true }).catch(() => []),
          ipv4: await resolve4(normalized).catch(() => []),
          ipv6: await resolve6(normalized).catch(() => []),
          mx: await resolveMx(normalized).catch(() => []),
          txt: await resolveTxt(normalized).catch(() => [])
        })),
        runProbe("otx.alienvault", () => probeOtxGeneral("domain", normalized))
      ]);
      probes = [dnsProbe, otx];
      const liveData: Record<string, unknown> = {};
      if (dnsProbe.status === "ok") {
        liveData.dns = dnsProbe.data;
      }
      if (otx.status === "ok") {
        liveData.otx = compactOtx(otx.data);
      }
      data = Object.keys(liveData).length > 0 ? liveData : null;
      assessment = otxAssessment("otx.alienvault", otx.data);
    } else if (isUrlLike(normalized)) {
      const otx = await runProbe("otx.alienvault", () => probeOtxGeneral("url", normalized));
      probes = [otx];
      if (otx.status === "ok") {
        data = { otx: compactOtx(otx.data) };
      }
      assessment = otxAssessment("otx.alienvault", otx.data);
    } else if (isHashLike(normalized)) {
      const hashlookup = await runProbe("hashlookup.circl.lu", () => probeHashlookup(normalized));
      probes = [hashlookup];
      if (hashlookup.status === "ok") {
        data = { hashlookup: compactHashlookup(hashlookup.data) };
      }
      assessment = hashlookupAssessment("hashlookup.circl.lu", hashlookup.data);
    }
  } else {
    probes = [skippedProbe("live-intel", "Indicator is private, documentation, or not network-resolvable.")];
  }

  const sanitizedProbes = probes.map(probeSummary);
  const report = reportFrom(sanitizedProbes);
  const result: LiveThreatIntelResult = { report, assessment, data, fromCache: false };
  if (report.status === "online") {
    await setCached(workspaceRoot, cacheKey, {
      report,
      assessment,
      data
    });
  }
  return result;
}

// ============================================================
// MITRE ATT&CK live technique page
// ============================================================

export async function liveMitreTechniqueLookup(techniqueId: string, workspaceRoot: string): Promise<LiveMitreTechniqueResult> {
  const normalized = techniqueId.trim().toUpperCase();
  const cacheKey = `mitre:${normalized}`;
  const cached = await getCached(workspaceRoot, cacheKey, MITRE_CACHE_TTL_MS);
  if (cached) {
    const parsed = asRecord(cached);
    if (parsed && parsed.report) {
      return {
        report: parsed.report as LiveReport,
        technique: (parsed.technique as LiveMitreTechniqueResult["technique"]) ?? null,
        fromCache: true
      };
    }
  }

  const url = `https://attack.mitre.org/techniques/${encodeURIComponent(normalized)}/`;
  const probe = await runProbe("attack.mitre.org", async () => {
    const html = await fetchText(url);
    return parseMitreTechniqueHtml(normalized, url, html);
  });
  const technique = asRecord(probe.data) as unknown as LiveMitreTechniqueResult["technique"] | null;
  const result: LiveMitreTechniqueResult = {
    report: reportFrom([probe]),
    technique,
    fromCache: false
  };
  if (probe.status === "ok") {
    await setCached(workspaceRoot, cacheKey, {
      report: result.report,
      technique
    });
  }
  return result;
}

function parseMitreTechniqueHtml(id: string, url: string, html: string): LiveMitreTechniqueResult["technique"] | null {
  const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
  const title = titleMatch?.[1]?.trim() ?? "";
  const descriptionMatch = html.match(/<meta\s+name="description"\s+content="([^"]*)"/i) ??
    html.match(/<meta\s+content="([^"]*)"\s+name="description"/i);
  const description = descriptionMatch?.[1]?.trim() ?? "";
  const nameMatch = title.match(/^([^|]+)/);
  const name = nameMatch?.[1]?.trim();
  if (!name && !description) {
    return null;
  }
  return {
    url,
    ...(name && name.toUpperCase() !== id ? { name } : {}),
    ...(description ? { description } : {}),
    raw: html.slice(0, 4_000)
  };
}

// ============================================================
// Live asset resolution (DNS / ipinfo for hostnames and IPs)
// ============================================================

export interface LiveAssetResolutionResult {
  report: LiveReport;
  data: Record<string, unknown> | null;
  fromCache: boolean;
}

export async function liveAssetResolution(asset: string, workspaceRoot: string): Promise<LiveAssetResolutionResult> {
  const normalized = asset.trim().toLowerCase();
  const cacheKey = `asset:${normalized}`;
  const cached = await getCached(workspaceRoot, cacheKey, IP_CACHE_TTL_MS);
  if (cached) {
    const parsed = asRecord(cached);
    if (parsed && parsed.report) {
      return {
        report: parsed.report as LiveReport,
        data: (parsed.data as Record<string, unknown> | null) ?? null,
        fromCache: true
      };
    }
  }

  let probes: LiveProbe[] = [];
  let data: Record<string, unknown> | null = null;

  if (isDomainLike(normalized)) {
    const dnsProbe = await runProbe("dns.lookup", async () => ({
      addresses: await dnsLookup(normalized, { all: true }).catch(() => []),
      ipv4: await resolve4(normalized).catch(() => []),
      ipv6: await resolve6(normalized).catch(() => []),
      mx: await resolveMx(normalized).catch(() => []),
      txt: await resolveTxt(normalized).catch(() => [])
    }));
    probes = [dnsProbe];
    if (dnsProbe.status === "ok") {
      data = { dns: dnsProbe.data };
    }
  } else if (isPublicIp(normalized)) {
    const [ipInfo, reverse] = await Promise.all([
      probeIpInfo(normalized),
      probeDnsReverse(normalized)
    ]);
    probes = [ipInfo, reverse];
    const liveData: Record<string, unknown> = {};
    if (ipInfo.status === "ok") {
      liveData.ipinfo = ipInfo.data;
    }
    if (reverse.status === "ok") {
      liveData.reverseHostnames = reverse.data;
    }
    data = Object.keys(liveData).length > 0 ? liveData : null;
  } else {
    probes = [skippedProbe("asset-resolution", "Asset is not a public IP or resolvable hostname.")];
  }

  const report = reportFrom(probes);
  const result: LiveAssetResolutionResult = { report, data, fromCache: false };
  if (report.status === "online") {
    await setCached(workspaceRoot, cacheKey, {
      report,
      data
    });
  }
  return result;
}

// ============================================================
// Live SigmaHQ rule tree search
// ============================================================

export interface LiveSigmaRuleSearchResult {
  report: LiveReport;
  rules: Array<{
    path: string;
    url: string;
  }>;
  truncated: boolean;
  fromCache: boolean;
}

const SIGMA_TREE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SIGMA_TREE_MAX_BYTES = 5_000_000;

async function fetchSigmaTree(): Promise<{ tree: Array<{ path?: string }>; truncated: boolean }> {
  const response = await fetchWithTimeout(
    "https://api.github.com/repos/SigmaHQ/sigma/git/trees/master?recursive=1",
    {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "secops-agent-live-enrichment"
      }
    },
    DEFAULT_HTTP_TIMEOUT_MS
  );
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for SigmaHQ tree`);
  }
  const text = await response.text();
  if (text.length > SIGMA_TREE_MAX_BYTES) {
    throw new Error(`SigmaHQ tree too large (${text.length} bytes)`);
  }
  const parsed = JSON.parse(text) as Record<string, unknown>;
  const tree = Array.isArray(parsed.tree) ? parsed.tree as Array<{ path?: string }> : [];
  return {
    tree,
    truncated: parsed.truncated === true
  };
}

export async function liveSigmaRuleSearch(query: string, workspaceRoot: string): Promise<LiveSigmaRuleSearchResult> {
  const terms = query.toLowerCase().split(/\W+/).filter(Boolean);
  if (terms.length === 0) {
    return {
      report: { status: "skipped", checkedAt: new Date().toISOString(), probes: [] },
      rules: [],
      truncated: false,
      fromCache: false
    };
  }

  const cacheKey = "sigma:rule-tree";
  const cached = await getCached(workspaceRoot, cacheKey, SIGMA_TREE_CACHE_TTL_MS);
  let paths: string[] = [];
  let truncated = false;
  let report: LiveReport;
  let fromCache = false;

  if (cached) {
    const parsed = asRecord(cached);
    if (parsed && Array.isArray(parsed.paths)) {
      paths = parsed.paths as string[];
      truncated = parsed.truncated === true;
      report = {
        status: "online",
        checkedAt: new Date().toISOString(),
        probes: [{ source: "cache:sigma-tree", status: "ok", latencyMs: 0 }]
      };
      fromCache = true;
    } else {
      report = reportFrom([]);
    }
  } else {
    const probe = await runProbe("github-api.sigmahq", async () => fetchSigmaTree(), DEFAULT_HTTP_TIMEOUT_MS);
    report = reportFrom([probe]);
    if (probe.status === "ok") {
      const parsed = asRecord(probe.data);
      if (parsed) {
        const tree = Array.isArray(parsed.tree) ? parsed.tree as Array<{ path?: string }> : [];
        paths = tree
          .filter((entry): entry is { path: string } => typeof entry.path === "string")
          .map((entry) => entry.path);
        truncated = parsed.truncated === true;
        await setCached(workspaceRoot, cacheKey, {
          paths,
          truncated,
          fetchedAt: new Date().toISOString()
        });
      }
    }
  }

  const matches = paths
    .filter((path) => path.endsWith(".yml"))
    .map((path) => ({
      path,
      score: terms.filter((term) => path.toLowerCase().includes(term)).length
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, 10)
    .map((entry) => ({
      path: entry.path,
      url: `https://github.com/SigmaHQ/sigma/blob/master/${encodeURIComponent(entry.path)}`
    }));

  return { report, rules: matches, truncated, fromCache };
}
