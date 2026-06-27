export class ShuffleConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShuffleConfigError";
  }
}

export interface ShuffleConfig {
  apiUrl: URL;
  apiKey: string;
  orgId?: string;
  timeoutMs: number;
}

export interface ShuffleConfigStatus {
  api: {
    configured: boolean;
    missing: string[];
    endpointHost?: string;
    apiPath?: string;
    urlHasCredentials: boolean;
    orgIdConfigured: boolean;
    timeoutMs: number;
  };
  smoke: {
    workflowIdConfigured: boolean;
    webhookUrlConfigured: boolean;
    executeWorkflowConfigured: boolean;
  };
}

export function shuffleConfigStatus(env: NodeJS.ProcessEnv = process.env): ShuffleConfigStatus {
  const urlValue = env.SHUFFLE_API_URL?.trim();
  const apiKey = env.SHUFFLE_API_KEY?.trim();
  const parsedUrl = parseOptionalUrl(urlValue);
  const missing = [
    ...(urlValue ? [] : ["SHUFFLE_API_URL"]),
    ...(apiKey ? [] : ["SHUFFLE_API_KEY"])
  ];
  return {
    api: {
      configured: missing.length === 0,
      missing,
      ...(parsedUrl ? { endpointHost: parsedUrl.host, apiPath: normalizeShuffleApiUrl(parsedUrl).pathname } : {}),
      urlHasCredentials: Boolean(parsedUrl?.username || parsedUrl?.password),
      orgIdConfigured: Boolean(env.SHUFFLE_ORG_ID?.trim()),
      timeoutMs: positiveInteger(env.SHUFFLE_REQUEST_TIMEOUT_MS, 15_000)
    },
    smoke: {
      workflowIdConfigured: Boolean(env.SHUFFLE_SMOKE_WORKFLOW_ID?.trim()),
      webhookUrlConfigured: Boolean(env.SHUFFLE_SMOKE_WEBHOOK_URL?.trim()),
      executeWorkflowConfigured:
        env.SHUFFLE_SMOKE_EXECUTE_WORKFLOW === "true" && env.SHUFFLE_SMOKE_CONFIRM === "execute-shuffle-workflow"
    }
  };
}

export function loadShuffleConfig(env: NodeJS.ProcessEnv = process.env): ShuffleConfig {
  const apiUrl = requiredUrl(env.SHUFFLE_API_URL, "SHUFFLE_API_URL");
  if (apiUrl.username || apiUrl.password) {
    throw new ShuffleConfigError("SHUFFLE_API_URL must not include credentials. Use SHUFFLE_API_KEY.");
  }
  const apiKey = requiredString(env.SHUFFLE_API_KEY, "SHUFFLE_API_KEY");
  return {
    apiUrl: normalizeShuffleApiUrl(apiUrl),
    apiKey,
    ...(env.SHUFFLE_ORG_ID?.trim() ? { orgId: env.SHUFFLE_ORG_ID.trim() } : {}),
    timeoutMs: positiveInteger(env.SHUFFLE_REQUEST_TIMEOUT_MS, 15_000)
  };
}

export function normalizeShuffleApiUrl(value: URL): URL {
  const normalized = new URL(value.toString());
  normalized.hash = "";
  normalized.search = "";
  const path = normalized.pathname.replace(/\/+$/, "");
  if (!path) {
    normalized.pathname = "/api/v1";
  } else if (path === "/api") {
    normalized.pathname = "/api/v1";
  } else {
    normalized.pathname = path;
  }
  return normalized;
}

function requiredString(value: string | undefined, key: string): string {
  if (!value?.trim()) {
    throw new ShuffleConfigError(`Missing required Shuffle configuration: ${key}`);
  }
  return value.trim();
}

function requiredUrl(value: string | undefined, key: string): URL {
  const text = requiredString(value, key);
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new ShuffleConfigError(`${key} must use http or https`);
    }
    return url;
  } catch (error) {
    if (error instanceof ShuffleConfigError) {
      throw error;
    }
    throw new ShuffleConfigError(`${key} must be a valid URL`);
  }
}

function parseOptionalUrl(value: string | undefined): URL | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value?.trim()) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
