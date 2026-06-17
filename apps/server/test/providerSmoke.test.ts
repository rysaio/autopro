import { describe, expect, it } from "vitest";
import { getConfig } from "../src/config.js";
import { runProviderToolSmoke } from "../scripts/providerToolSmoke.js";

describe("provider tool-call smoke", () => {
  it("requires real provider configuration before making a live smoke call", async () => {
    await expect(runProviderToolSmoke(getConfig({}))).rejects.toThrow("Model provider configuration is required");
  });
});
