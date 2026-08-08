import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ToolVisibilityStore } from "../src/runtime/toolVisibilityStore.js";

function tempStore(): { filePath: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "secops-tool-visibility-"));
  return { filePath: path.join(dir, "toolVisibility.json") };
}

describe("ToolVisibilityStore", () => {
  it("starts empty when the file does not exist", () => {
    const { filePath } = tempStore();
    const store = new ToolVisibilityStore(filePath);

    expect(store.get()).toEqual({});
  });

  it("sets, clears, and persists overrides", () => {
    const { filePath } = tempStore();
    const store = new ToolVisibilityStore(filePath);

    store.set("wazuh.alerts.search", false);
    store.set("report.generate", true);
    expect(store.get()).toEqual({
      "wazuh.alerts.search": false,
      "report.generate": true
    });
    expect(JSON.parse(readFileSync(filePath, "utf8"))).toEqual(store.get());

    expect(store.clear("wazuh.alerts.search")).toBe(true);
    expect(store.clear("wazuh.alerts.search")).toBe(false);
    expect(store.get()).toEqual({ "report.generate": true });

    const reloaded = new ToolVisibilityStore(filePath);
    expect(reloaded.get()).toEqual({ "report.generate": true });
  });

  it("throws for malformed or invalid files", () => {
    const malformed = tempStore();
    writeFileSync(malformed.filePath, "{not-json", "utf8");
    expect(() => new ToolVisibilityStore(malformed.filePath)).toThrow();

    const invalid = tempStore();
    writeFileSync(invalid.filePath, JSON.stringify({ "report.generate": "yes" }), "utf8");
    expect(() => new ToolVisibilityStore(invalid.filePath)).toThrow("Invalid tool visibility config");
  });
});
