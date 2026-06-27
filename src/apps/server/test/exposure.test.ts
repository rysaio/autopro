import { describe, expect, it } from "vitest";
import { buildServer } from "../src/app.js";
import { getConfig } from "../src/config.js";
import { testConfig } from "./fixtures/testConfig.js";

describe("exposure controls", () => {
  it("defaults to loopback bind and localhost web origins", () => {
    const config = getConfig({
      SECOPS_CONFIG_PATH: "__missing-secops.config.json"
    });

    expect(config.bindHost).toBe("127.0.0.1");
    expect(config.modelBaseUrl).toBeUndefined();
    expect(config.allowedHosts).toContain("localhost");
    expect(config.allowedHosts).toContain("127.0.0.1");
    expect(config.allowedOrigins).toContain("http://localhost:5317");
  });

  it("rejects requests from unexpected hosts and origins by default", async () => {
    const app = buildServer(testConfig({
    }));

    const badHost = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: {
        host: "evil.example"
      }
    });
    expect(badHost.statusCode).toBe(403);

    const badOrigin = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: {
        origin: "http://evil.example"
      }
    });
    expect(badOrigin.statusCode).toBe(403);

    const localOrigin = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: {
        origin: "http://localhost:5317"
      }
    });
    expect(localOrigin.statusCode).toBe(200);
    expect(localOrigin.headers["access-control-allow-origin"]).toBe("http://localhost:5317");

    await app.close();
  });

  it("allows explicit host and origin overrides", async () => {
    const app = buildServer(testConfig({
      SECOPS_ALLOWED_HOSTS: "ops.example",
      SECOPS_ALLOWED_ORIGINS: "https://ops.example"
    }));

    const allowed = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: {
        host: "ops.example",
        origin: "https://ops.example"
      }
    });
    expect(allowed.statusCode).toBe(200);

    const blocked = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: {
        host: "localhost",
        origin: "http://localhost:5317"
      }
    });
    expect(blocked.statusCode).toBe(403);

    await app.close();
  });

  it("requires bearer auth when SECOPS_API_TOKEN is configured", async () => {
    const app = buildServer(testConfig({
      SECOPS_API_TOKEN: "test-token"
    }));

    const missing = await app.inject({
      method: "GET",
      url: "/api/health"
    });
    expect(missing.statusCode).toBe(401);

    const wrong = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: {
        authorization: "Bearer wrong-token"
      }
    });
    expect(wrong.statusCode).toBe(401);

    const allowed = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: {
        authorization: "Bearer test-token"
      }
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().apiTokenRequired).toBe(true);

    await app.close();
  });
});
