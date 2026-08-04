export interface WazuhConfigStatus {
  serverApi: {
    configured: boolean;
    missing: string[];
    endpointHost: string | undefined;
    urlHasCredentials: boolean;
    tlsVerify: boolean;
    caCertConfigured: boolean;
    requestTimeoutConfigured: boolean;
  };
  indexer: {
    configured: boolean;
    missing: string[];
    endpointHost: string | undefined;
    urlHasCredentials: boolean;
    alertsIndex: string;
    tlsVerify: boolean;
    caCertConfigured: boolean;
    requestTimeoutConfigured: boolean;
  };
  smoke: {
    agentIdConfigured: boolean;
    alertFilterConfigured: boolean;
    blockIpConfigured: boolean;
    executeBlockRequested: boolean;
    executeBlockConfirmed: boolean;
  };
  isDemo: boolean;
}

function isDemoMode(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.SECOPS_DEMO_MODE?.trim().toLowerCase() === "true") {
    return true;
  }
  const apiUrl = env.WAZUH_API_URL?.trim();
  return !apiUrl || apiUrl.toLowerCase() === "demo";
}

export function wazuhConfigStatus(env: NodeJS.ProcessEnv = process.env): WazuhConfigStatus {
  const demo = isDemoMode(env);
  const serverApiMissing = demo ? [] : missingEnv(env, ["WAZUH_API_URL", "WAZUH_API_USER", "WAZUH_API_PASSWORD"]);
  const indexerMissing = demo ? [] : missingEnv(env, ["WAZUH_INDEXER_URL", "WAZUH_INDEXER_USER", "WAZUH_INDEXER_PASSWORD"]);
  return {
    serverApi: {
      configured: demo || serverApiMissing.length === 0,
      missing: serverApiMissing,
      endpointHost: demo ? "demo.local:55000" : endpointHost(env.WAZUH_API_URL),
      urlHasCredentials: demo ? false : urlHasCredentials(env.WAZUH_API_URL),
      tlsVerify: demo ? false : env.WAZUH_TLS_VERIFY?.trim().toLowerCase() !== "false",
      caCertConfigured: demo ? false : Boolean(env.WAZUH_CA_CERT_PATH?.trim()),
      requestTimeoutConfigured: demo ? false : Boolean(env.WAZUH_REQUEST_TIMEOUT_MS?.trim())
    },
    indexer: {
      configured: demo || indexerMissing.length === 0,
      missing: indexerMissing,
      endpointHost: demo ? "demo-indexer.local:9200" : endpointHost(env.WAZUH_INDEXER_URL),
      urlHasCredentials: demo ? false : urlHasCredentials(env.WAZUH_INDEXER_URL),
      alertsIndex: demo ? "wazuh-alerts-*" : (env.WAZUH_ALERTS_INDEX?.trim() || "wazuh-alerts-*"),
      tlsVerify: demo ? false : (env.WAZUH_INDEXER_TLS_VERIFY ?? env.WAZUH_TLS_VERIFY)?.trim().toLowerCase() !== "false",
      caCertConfigured: demo ? false : Boolean(env.WAZUH_INDEXER_CA_CERT_PATH?.trim() || env.WAZUH_CA_CERT_PATH?.trim()),
      requestTimeoutConfigured: demo ? false : Boolean((env.WAZUH_INDEXER_REQUEST_TIMEOUT_MS || env.WAZUH_REQUEST_TIMEOUT_MS)?.trim())
    },
    smoke: {
      agentIdConfigured: Boolean(env.WAZUH_SMOKE_AGENT_ID?.trim()),
      alertFilterConfigured: Boolean(
        env.WAZUH_SMOKE_ALERT_SOURCE_IP?.trim() ||
          env.WAZUH_SMOKE_ALERT_AGENT_ID?.trim() ||
          env.WAZUH_SMOKE_ALERT_RULE_ID?.trim()
      ),
      blockIpConfigured: Boolean(env.WAZUH_SMOKE_BLOCK_IP?.trim()),
      executeBlockRequested: env.WAZUH_SMOKE_EXECUTE_BLOCK === "true",
      executeBlockConfirmed: env.WAZUH_SMOKE_CONFIRM === "execute-active-response"
    },
    isDemo: demo
  };
}

function missingEnv(env: NodeJS.ProcessEnv, keys: string[]): string[] {
  return keys.filter((key) => !env[key]?.trim());
}

function endpointHost(rawUrl: string | undefined): string | undefined {
  if (!rawUrl?.trim()) {
    return undefined;
  }
  try {
    return new URL(rawUrl).host;
  } catch {
    return undefined;
  }
}

function urlHasCredentials(rawUrl: string | undefined): boolean {
  if (!rawUrl?.trim()) {
    return false;
  }
  try {
    const url = new URL(rawUrl);
    return Boolean(url.username || url.password);
  } catch {
    return false;
  }
}