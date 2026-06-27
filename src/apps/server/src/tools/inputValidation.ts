import type { SkillManifest, ToolSchema } from "@secops-agent/shared";

export interface ToolInputValidationResult {
  ok: boolean;
  error?: string;
}

export function validateToolInput(manifest: SkillManifest, args: Record<string, unknown>): ToolInputValidationResult {
  const schema = manifest.inputSchema;
  if (schema.type !== "object") {
    return { ok: false, error: `Unsupported input schema root for ${manifest.id}` };
  }

  for (const requiredKey of schema.required ?? []) {
    if (!(requiredKey in args) || args[requiredKey] === undefined || args[requiredKey] === null) {
      return { ok: false, error: `Missing required argument "${requiredKey}" for ${manifest.id}` };
    }
  }

  if (schema.additionalProperties === false) {
    const allowed = new Set(Object.keys(schema.properties));
    const extra = Object.keys(args).find((key) => !allowed.has(key));
    if (extra) {
      return { ok: false, error: `Unexpected argument "${extra}" for ${manifest.id}` };
    }
  }

  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) {
      continue;
    }
    const property = schema.properties[key];
    if (!property || !isRecord(property)) {
      continue;
    }
    const result = validateProperty(schema, key, value, property);
    if (!result.ok) {
      return { ok: false, error: `${result.error} for ${manifest.id}` };
    }
  }

  return { ok: true };
}

function validateProperty(
  rootSchema: ToolSchema,
  key: string,
  value: unknown,
  property: Record<string, unknown>
): ToolInputValidationResult {
  const enumValues = Array.isArray(property.enum) ? property.enum : undefined;
  if (enumValues && !enumValues.includes(value)) {
    return { ok: false, error: `Invalid value for argument "${key}"` };
  }

  if (property.type === "string" && typeof value !== "string") {
    return { ok: false, error: `Expected argument "${key}" to be a string` };
  }

  if (property.type === "array") {
    if (!Array.isArray(value)) {
      return { ok: false, error: `Expected argument "${key}" to be an array` };
    }
    const items = property.items;
    if (isRecord(items) && items.type === "string" && value.some((item) => typeof item !== "string")) {
      return { ok: false, error: `Expected argument "${key}" items to be strings` };
    }
  }

  if (property.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) {
    return { ok: false, error: `Expected argument "${key}" to be a number` };
  }

  if (!property.type && rootSchema.required?.includes(key)) {
    return { ok: false, error: `Unsupported schema for required argument "${key}"` };
  }

  return { ok: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
