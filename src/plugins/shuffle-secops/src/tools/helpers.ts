import type { EvidenceArtifact } from "./types.js";

export function artifact(title: string, summary: string, data: unknown): EvidenceArtifact {
  return {
    id: `artifact-${crypto.randomUUID()}`,
    title,
    kind: "runtime",
    summary,
    data,
    createdAt: new Date().toISOString()
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Expected non-empty string argument: ${key}`);
  }
  return value.trim();
}

export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim().length ? value.trim() : undefined;
}

export function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function boundedInteger(args: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const value = optionalNumber(args, key) ?? fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${key} must be an integer from ${min} to ${max}`);
  }
  return value;
}

export function parseJsonObject(value: string | undefined, label: string): Record<string, unknown> {
  if (!value) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed;
}

export function responseItems(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (!isRecord(value)) {
    return [];
  }
  for (const key of ["workflows", "apps", "executions", "data", "items", "results"]) {
    const candidate = value[key];
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }
  return [];
}

export function pickSummary(value: unknown, keys: string[]): Record<string, unknown> {
  if (!isRecord(value)) {
    return {};
  }
  const summary: Record<string, unknown> = {};
  for (const key of keys) {
    const current = value[key];
    if (current !== undefined) {
      summary[key] = current;
    }
  }
  return summary;
}
