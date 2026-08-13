import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SkillVisibilityStore } from "../src/runtime/skillVisibilityStore.js";

function tempStore(): { filePath: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "secops-skill-visibility-"));
  return { filePath: path.join(dir, "skillVisibility.json") };
}

describe("SkillVisibilityStore", () => {
  it("starts empty and treats missing ids as enabled", () => {
    const { filePath } = tempStore();
    const store = new SkillVisibilityStore(filePath);

    expect(store.get()).toEqual({});
    expect(store.isEnabled("case-review")).toBe(true);
  });

  it("sets, persists, and restores overrides", () => {
    const { filePath } = tempStore();
    const store = new SkillVisibilityStore(filePath);

    store.set("case-review", false);
    store.set("wazuh:alert-triage", true);
    expect(store.isEnabled("case-review")).toBe(false);
    expect(store.isEnabled("wazuh:alert-triage")).toBe(true);
    expect(JSON.parse(readFileSync(filePath, "utf8"))).toEqual({
      "case-review": false,
      "wazuh:alert-triage": true
    });

    const reloaded = new SkillVisibilityStore(filePath);
    expect(reloaded.isEnabled("case-review")).toBe(false);
    expect(reloaded.isEnabled("wazuh:alert-triage")).toBe(true);
  });

  it("throws for malformed or invalid files", () => {
    const malformed = tempStore();
    writeFileSync(malformed.filePath, "{not-json", "utf8");
    expect(() => new SkillVisibilityStore(malformed.filePath)).toThrow();

    const invalid = tempStore();
    writeFileSync(invalid.filePath, JSON.stringify({ "case-review": "yes" }), "utf8");
    expect(() => new SkillVisibilityStore(invalid.filePath)).toThrow("Invalid skill visibility config");
  });
});
