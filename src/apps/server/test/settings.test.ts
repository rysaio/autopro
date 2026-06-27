import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildServer } from "../src/app.js";
import { testConfig } from "./fixtures/testConfig.js";

describe("runtime settings", () => {
  it("updates action level through the API and persists it locally", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "secops-settings-"));
    const settingsPath = path.join(dir, "settings.json");
    const app = buildServer(testConfig({
      SECOPS_RUNTIME_CONFIG_PATH: settingsPath
    }));

    const initialHealth = await app.inject({
      method: "GET",
      url: "/api/health"
    });
    expect(initialHealth.json().actionLevel).toBe("sandbox");

    const updated = await app.inject({
      method: "POST",
      url: "/api/settings/action-level",
      payload: {
        actionLevel: "full-access"
      }
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().actionLevel).toBe("full-access");

    const health = await app.inject({
      method: "GET",
      url: "/api/health"
    });
    expect(health.json().actionLevel).toBe("full-access");
    await expect(readFile(settingsPath, "utf8")).resolves.toContain("full-access");

    await app.close();
  });

  it("rejects unknown action levels", async () => {
    const app = buildServer(testConfig({
    }));

    const response = await app.inject({
      method: "POST",
      url: "/api/settings/action-level",
      payload: {
        actionLevel: "root"
      }
    });
    expect(response.statusCode).toBe(400);

    await app.close();
  });
});
