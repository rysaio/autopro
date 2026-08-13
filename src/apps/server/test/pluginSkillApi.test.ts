import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildServer } from "../src/app.js";
import { testConfig } from "./fixtures/testConfig.js";

async function writeSkill(root: string, id: string, body: string): Promise<void> {
  const skillDir = path.join(root, id);
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, "SKILL.md"), [
    "---",
    `name: ${id}`,
    `description: ${id} description`,
    "---",
    "",
    body,
    ""
  ].join("\n"), "utf8");
}

describe("plugin and skill APIs", () => {
  it("loads standalone and pure-skill plugins, reads content, and reloads without restart", async () => {
    const config = testConfig();
    await writeSkill(config.skillsDir, "standalone-review", "# Standalone\n\nFirst version.");
    const pluginRoot = path.join(config.pluginsDir, "skill-only");
    await mkdir(path.join(pluginRoot, ".codex-plugin"), { recursive: true });
    await writeFile(path.join(pluginRoot, ".codex-plugin", "plugin.json"), JSON.stringify({
      name: "Skill Only",
      version: "1.0.0",
      description: "A plugin with no MCP server.",
      skills: "./skills"
    }), "utf8");
    await writeSkill(path.join(pluginRoot, "skills"), "plugin-review", "# Plugin\n\nPlugin body.");
    const app = buildServer(config);

    const skills = await app.inject({ method: "GET", url: "/api/skills" });
    expect(skills.statusCode).toBe(200);
    expect(skills.json().skills).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "standalone-review", source: "standalone", status: "loaded" }),
      expect.objectContaining({ id: "skill-only:plugin-review", source: "plugin", status: "loaded" })
    ]));
    expect(JSON.stringify(skills.json())).not.toContain("Plugin body");

    const plugins = await app.inject({ method: "GET", url: "/api/plugins" });
    expect(plugins.statusCode).toBe(200);
    expect(plugins.json().plugins).toEqual([
      expect.objectContaining({
        id: "skill-only",
        status: "loaded",
        toolCount: 0,
        skillCount: 1
      })
    ]);
    expect(plugins.json().plugins[0]).not.toHaveProperty("skills");

    const content = await app.inject({ method: "GET", url: "/api/skills/skill-only%3Aplugin-review" });
    expect(content.statusCode).toBe(200);
    expect(content.json().content).toBe("# Plugin\n\nPlugin body.");

    const missing = await app.inject({ method: "GET", url: "/api/skills/missing" });
    expect(missing.statusCode).toBe(404);

    const skillVisibility = await app.inject({ method: "GET", url: "/api/skills/visibility" });
    expect(skillVisibility.statusCode).toBe(200);
    expect(skillVisibility.json().visibility).toEqual({});

    // 关闭技能后：列表带 enabled=false，正文预览仍可读，非法输入被拒绝
    const disabled = await app.inject({
      method: "PUT",
      url: "/api/skills/visibility/standalone-review",
      payload: { enabled: false }
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().visibility).toEqual({ "standalone-review": false });
    const afterDisable = await app.inject({ method: "GET", url: "/api/skills" });
    expect(afterDisable.json().skills).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "standalone-review", enabled: false })
    ]));
    const preview = await app.inject({ method: "GET", url: "/api/skills/standalone-review" });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().content).toContain("First version");
    const invalidBody = await app.inject({
      method: "PUT",
      url: "/api/skills/visibility/standalone-review",
      payload: { enabled: "yes" }
    });
    expect(invalidBody.statusCode).toBe(400);
    const unknownSkill = await app.inject({
      method: "PUT",
      url: "/api/skills/visibility/not-a-skill",
      payload: { enabled: true }
    });
    expect(unknownSkill.statusCode).toBe(404);

    await writeSkill(config.skillsDir, "standalone-review", "# Standalone\n\nSecond version.");
    const beforeReload = await app.inject({ method: "GET", url: "/api/skills/standalone-review" });
    expect(beforeReload.json().content).toContain("First version");
    const reloaded = await app.inject({ method: "POST", url: "/api/skills/reload" });
    expect(reloaded.statusCode).toBe(200);
    const afterReload = await app.inject({ method: "GET", url: "/api/skills/standalone-review" });
    expect(afterReload.json().content).toContain("Second version");

    for (const url of ["/api/capabilities", "/api/tool-packs", "/api/mcp/tool-packs"]) {
      const removed = await app.inject({ method: "GET", url });
      expect(removed.statusCode).toBe(404);
    }

    await app.close();
  });
});
