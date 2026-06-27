import { describe, expect, it } from "vitest";
import {
  WazuhConfigError,
  WazuhIndexerConfigError,
  alertSearchBody,
  loadWazuhConfig,
  loadWazuhIndexerConfig,
  wazuhConfigStatus
} from "../src/index.js";

describe("wazuh plugin core", () => {
  it("reports sanitized missing configuration", () => {
    const status = wazuhConfigStatus({});

    expect(status.serverApi.configured).toBe(false);
    expect(status.serverApi.missing).toEqual(["WAZUH_API_URL", "WAZUH_API_USER", "WAZUH_API_PASSWORD"]);
    expect(status.indexer.configured).toBe(false);
    expect(status.indexer.missing).toEqual([
      "WAZUH_INDEXER_URL",
      "WAZUH_INDEXER_USER",
      "WAZUH_INDEXER_PASSWORD"
    ]);
    expect(JSON.stringify(status)).not.toContain("password");
    expect(JSON.stringify(status)).not.toContain("token");
  });

  it("redacts URL credentials into boolean readiness only", () => {
    const status = wazuhConfigStatus({
      WAZUH_API_URL: "https://user:secret@wazuh.example:55000",
      WAZUH_API_USER: "api-user",
      WAZUH_API_PASSWORD: "api-password",
      WAZUH_INDEXER_URL: "https://idx-user:idx-secret@indexer.example:9200",
      WAZUH_INDEXER_USER: "idx-user",
      WAZUH_INDEXER_PASSWORD: "idx-password"
    });

    expect(status.serverApi.configured).toBe(true);
    expect(status.serverApi.endpointHost).toBe("wazuh.example:55000");
    expect(status.serverApi.urlHasCredentials).toBe(true);
    expect(status.indexer.configured).toBe(true);
    expect(status.indexer.endpointHost).toBe("indexer.example:9200");
    expect(status.indexer.urlHasCredentials).toBe(true);
    expect(JSON.stringify(status)).not.toContain("secret");
    expect(JSON.stringify(status)).not.toContain("api-password");
    expect(JSON.stringify(status)).not.toContain("idx-password");
  });

  it("loads Wazuh API configuration without URL credentials", () => {
    const config = loadWazuhConfig({
      WAZUH_API_URL: "https://wazuh.example:55000",
      WAZUH_API_USER: "api-user",
      WAZUH_API_PASSWORD: "api-password",
      WAZUH_TLS_VERIFY: "false",
      WAZUH_REQUEST_TIMEOUT_MS: "1234",
      WAZUH_BLOCK_IP_COMMANDS: "firewall-drop,route-null",
      WAZUH_MAX_BLOCK_DURATION_SECONDS: "60"
    });

    expect(config.apiUrl.host).toBe("wazuh.example:55000");
    expect(config.username).toBe("api-user");
    expect(config.password).toBe("api-password");
    expect(config.tlsVerify).toBe(false);
    expect(config.timeoutMs).toBe(1234);
    expect(config.blockIpCommands).toEqual(["firewall-drop", "route-null"]);
    expect(config.maxBlockDurationSeconds).toBe(60);
  });

  it("rejects Wazuh API URLs that include credentials", () => {
    expect(() =>
      loadWazuhConfig({
        WAZUH_API_URL: "https://user:secret@wazuh.example:55000",
        WAZUH_API_USER: "api-user",
        WAZUH_API_PASSWORD: "api-password"
      })
    ).toThrow(WazuhConfigError);
  });

  it("loads Indexer configuration and default alert index", () => {
    const config = loadWazuhIndexerConfig({
      WAZUH_INDEXER_URL: "https://indexer.example:9200",
      WAZUH_INDEXER_USER: "idx-user",
      WAZUH_INDEXER_PASSWORD: "idx-password",
      WAZUH_INDEXER_TLS_VERIFY: "false"
    });

    expect(config.indexerUrl.host).toBe("indexer.example:9200");
    expect(config.alertsIndex).toBe("wazuh-alerts-*");
    expect(config.tlsVerify).toBe(false);
  });

  it("rejects Indexer URLs that include credentials", () => {
    expect(() =>
      loadWazuhIndexerConfig({
        WAZUH_INDEXER_URL: "https://idx-user:secret@indexer.example:9200",
        WAZUH_INDEXER_USER: "idx-user",
        WAZUH_INDEXER_PASSWORD: "idx-password"
      })
    ).toThrow(WazuhIndexerConfigError);
  });

  it("builds bounded alert searches for lateral and IP workflows", () => {
    const body = alertSearchBody({
      sourceIp: "10.0.0.5",
      agentId: "001",
      ruleId: "5710",
      timeWindowMinutes: 120,
      limit: 25
    });

    expect(body).toMatchObject({
      size: 25,
      query: {
        bool: {
          filter: expect.arrayContaining([
            { term: { "agent.id": "001" } },
            { term: { "rule.id": "5710" } }
          ])
        }
      }
    });
    expect(JSON.stringify(body)).toContain("10.0.0.5");
    expect(JSON.stringify(body)).toContain("now-120m");
  });
});
