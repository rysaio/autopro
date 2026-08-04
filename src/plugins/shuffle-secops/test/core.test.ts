import { describe, expect, it } from "vitest";
import {
  loadShuffleConfig,
  normalizeShuffleApiUrl,
  shuffleConfigStatus,
  ShuffleConfigError,
  ShuffleClient
} from "../src/index.js";

describe("shuffle plugin core", () => {
  it("reports sanitized missing configuration", () => {
    const status = shuffleConfigStatus({});

    expect(status.api.configured).toBe(false);
    expect(status.api.missing).toEqual(["SHUFFLE_API_URL", "SHUFFLE_API_KEY"]);
    expect(JSON.stringify(status)).not.toContain("secret");
    expect(JSON.stringify(status)).not.toContain("token");
    expect(JSON.stringify(status)).not.toContain("api-key");
  });

  it("redacts URL credentials into boolean readiness only", () => {
    const status = shuffleConfigStatus({
      SHUFFLE_API_URL: "https://user:secret@shuffle.example/api/v1",
      SHUFFLE_API_KEY: "api-key",
      SHUFFLE_ORG_ID: "org-1"
    });

    expect(status.api.configured).toBe(true);
    expect(status.api.endpointHost).toBe("shuffle.example");
    expect(status.api.urlHasCredentials).toBe(true);
    expect(status.api.orgIdConfigured).toBe(true);
    expect(JSON.stringify(status)).not.toContain("api-key");
    expect(JSON.stringify(status)).not.toContain("secret");
  });

  it("loads Shuffle configuration without URL credentials", () => {
    const config = loadShuffleConfig({
      SHUFFLE_API_URL: "https://shuffle.example",
      SHUFFLE_API_KEY: "api-key",
      SHUFFLE_ORG_ID: "org-1",
      SHUFFLE_REQUEST_TIMEOUT_MS: "1234"
    });

    expect(config.apiUrl.toString()).toBe("https://shuffle.example/api/v1");
    expect(config.apiKey).toBe("api-key");
    expect(config.orgId).toBe("org-1");
    expect(config.timeoutMs).toBe(1234);
  });

  it("rejects Shuffle API URLs that include credentials", () => {
    expect(() =>
      loadShuffleConfig({
        SHUFFLE_API_URL: "https://user:secret@shuffle.example/api/v1",
        SHUFFLE_API_KEY: "api-key"
      })
    ).toThrow(ShuffleConfigError);
  });

  it("normalizes host and /api URLs to /api/v1", () => {
    expect(normalizeShuffleApiUrl(new URL("https://shuffle.example")).toString()).toBe("https://shuffle.example/api/v1");
    expect(normalizeShuffleApiUrl(new URL("https://shuffle.example/api")).toString()).toBe("https://shuffle.example/api/v1");
    expect(normalizeShuffleApiUrl(new URL("https://shuffle.example/api/v1/")).toString()).toBe("https://shuffle.example/api/v1");
  });

  it("sends bearer and org headers to Shuffle API requests", async () => {
    const seen: Array<{ url: string; headers: Headers }> = [];
    const client = new ShuffleClient(
      {
        apiUrl: new URL("https://shuffle.example/api/v1"),
        apiKey: "api-key",
        orgId: "org-1",
        timeoutMs: 1000
      },
      async (input, init) => {
        seen.push({ url: String(input), headers: new Headers(init?.headers) });
        return new Response(JSON.stringify([{ id: "wf-1", name: "Triage" }]), { status: 200 });
      }
    );

    const result = await client.listWorkflows({ limit: 1 });

    expect(result).toEqual([{ id: "wf-1", name: "Triage" }]);
    expect(seen[0]?.url).toBe("https://shuffle.example/api/v1/workflows?limit=1");
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer api-key");
    expect(seen[0]?.headers.get("Org-Id")).toBe("org-1");
  });
});
