import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SkillCatalog } from "../src/skills/catalog.js";
import { createSkillReadTool } from "../src/skills/skillReadTool.js";
import { systemPromptWithSkills } from "../src/runtime/systemPrompt.js";

async function writeSkill(root: string, directory: string, metadataName = directory, body = "# Instructions"): Promise<void> {
  const skillDir = path.join(root, directory);
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, "SKILL.md"), [
    "---",
    `name: ${metadataName}`,
    "description: 'Read alerts: safely and accurately'",
    "---",
    "",
    body,
    ""
  ].join("\n"), "utf8");
}

describe("SkillCatalog", () => {
  it("loads standalone and namespaced plugin skills and reads body on demand", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "secops-skills-"));
    const standaloneRoot = path.join(dir, "skills");
    const pluginRoot = path.join(dir, "plugins", "wazuh");
    const pluginSkills = path.join(pluginRoot, "skills");
    await writeSkill(standaloneRoot, "case-review", "case-review", "# Case Review\n\nReview evidence.");
    await writeSkill(pluginSkills, "alert-triage", "alert-triage", "# Alert Triage\n\nUse read-only tools.");
    const catalog = new SkillCatalog({ standaloneRoot });

    const summaries = catalog.reload([{
      pluginId: "wazuh",
      pluginRoot,
      skillsRoot: pluginSkills
    }]);

    expect(summaries).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "case-review", source: "standalone", status: "loaded" }),
      expect.objectContaining({ id: "wazuh:alert-triage", source: "plugin", pluginId: "wazuh", status: "loaded" })
    ]));
    expect(catalog.read("wazuh:alert-triage")).toMatchObject({
      id: "wazuh:alert-triage",
      content: "# Alert Triage\n\nUse read-only tools."
    });
    expect(JSON.stringify(summaries)).not.toContain(dir);
    expect(catalog.promptSummary()).toContain("wazuh:alert-triage");
    expect(catalog.promptSummary()).not.toContain("Use read-only tools");
    const prompt = systemPromptWithSkills("base prompt", catalog.promptSummary());
    expect(prompt).toContain("wazuh:alert-triage");
    expect(prompt).not.toContain("Use read-only tools");

    const result = await createSkillReadTool(catalog).execute({ id: "wazuh:alert-triage" }, {
      runId: "skill-test",
      permissionMode: "deny",
      actionLevel: "observe",
      sandboxRoot: path.join(dir, "sandbox"),
      workspaceRoot: dir
    });
    expect(result.output).toMatchObject({
      id: "wazuh:alert-triage",
      content: "# Alert Triage\n\nUse read-only tools."
    });
  });

  it("reports invalid skills without exposing paths or registering their content", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "secops-skills-"));
    const standaloneRoot = path.join(dir, "skills");
    await writeSkill(standaloneRoot, "wrong-name", "different-name");
    await mkdir(path.join(standaloneRoot, "missing-file"), { recursive: true });
    const catalog = new SkillCatalog({ standaloneRoot });

    const summaries = catalog.reload();

    expect(summaries).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "wrong-name", status: "error", error: expect.stringContaining("match") }),
      expect.objectContaining({ id: "missing-file", status: "error", error: expect.stringContaining("missing") })
    ]));
    expect(catalog.read("wrong-name")).toBeUndefined();
    expect(JSON.stringify(summaries)).not.toContain(dir);
  });

  it("rejects a plugin skills root outside its plugin directory", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "secops-skills-"));
    const pluginRoot = path.join(dir, "plugin");
    const outsideRoot = path.join(dir, "outside");
    await mkdir(pluginRoot, { recursive: true });
    await writeSkill(outsideRoot, "escaped");
    const catalog = new SkillCatalog({ standaloneRoot: path.join(dir, "standalone") });

    const summaries = catalog.reload([{ pluginId: "demo", pluginRoot, skillsRoot: outsideRoot }]);

    expect(summaries).toEqual([
      expect.objectContaining({ id: "demo:skills", status: "error", error: expect.stringContaining("outside") })
    ]);
  });

  it("refreshes metadata and content only after reload", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "secops-skills-"));
    const standaloneRoot = path.join(dir, "skills");
    await writeSkill(standaloneRoot, "case-review", "case-review", "first body");
    const catalog = new SkillCatalog({ standaloneRoot });
    catalog.reload();
    await writeSkill(standaloneRoot, "case-review", "case-review", "second body");

    expect(catalog.read("case-review")?.content).toBe("first body");
    catalog.reload();
    expect(catalog.read("case-review")?.content).toBe("second body");
  });

  it("enforces the configured SKILL.md size limit", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "secops-skills-"));
    const standaloneRoot = path.join(dir, "skills");
    await writeSkill(standaloneRoot, "large-skill", "large-skill", "x".repeat(512));
    const catalog = new SkillCatalog({ standaloneRoot, maxSkillBytes: 128 });

    expect(catalog.reload()).toEqual([
      expect.objectContaining({ id: "large-skill", status: "error", error: expect.stringContaining("128") })
    ]);
  });

  it("hides disabled skills from the agent but keeps preview content readable", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "secops-skills-"));
    const standaloneRoot = path.join(dir, "skills");
    const disabled = new Set<string>(["case-review"]);
    await writeSkill(standaloneRoot, "case-review", "case-review", "# Case Review\n\nSecret body.");
    const catalog = new SkillCatalog({
      standaloneRoot,
      isEnabled: (id) => !disabled.has(id)
    });
    catalog.reload();

    // 列表带 enabled 标记，界面可渲染开关
    expect(catalog.list()).toEqual([
      expect.objectContaining({ id: "case-review", status: "loaded", enabled: false })
    ]);
    // 模型侧：提示不出现、read 视为不存在
    expect(catalog.promptSummary()).not.toContain("case-review");
    expect(catalog.read("case-review")).toBeUndefined();
    // 界面预览：正文仍可读取
    expect(catalog.content("case-review")?.content).toContain("Secret body");
  });
});
