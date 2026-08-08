import { describe, expect, it } from "vitest";
import type { ModelTool } from "../src/providers/types.js";
import { toolRouter } from "../src/runtime/toolRouter.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { SecOpsTool, ToolContext, ToolExecutionResult } from "../src/tools/types.js";

function pluginTool(apiName: string, manifestId: string, packId: string, deferLoading = true): SecOpsTool {
  return {
    apiName,
    manifest: {
      id: manifestId,
      skillPackId: packId,
      name: manifestId,
      description: "Plugin tool.",
      toolClass: "perception",
      risk: "low",
      deferLoading,
      tags: [packId],
      mcpCompatible: true,
      inputSchema: { type: "object", properties: {} }
    },
    toModelTool: (): ModelTool => ({
      type: "function",
      function: { name: apiName, description: "x", parameters: {} }
    }),
    execute: async (_args: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> => ({
      output: { ok: true }
    })
  };
}

describe("toolRouter layered routing with plugins", () => {
  it("includes a non-core always-visible tool in triage", () => {
    const registry = new ToolRegistry();
    registry.registerTools([
      pluginTool("secops_thirdparty_query", "thirdparty.query", "thirdparty-pack", false)
    ]);

    toolRouter.build(registry);

    expect(toolRouter.getTriageToolIds()).toContain("thirdparty.query");
  });

  it("keeps deferred tools out of triage and loads them through inferred deep categories", () => {
    const registry = new ToolRegistry();
    registry.registerTools([
      pluginTool("secops_wazuh_alerts_search", "wazuh.alerts.search", "secops-wazuh")
    ]);

    toolRouter.build(registry);
    const categories = toolRouter.inferCategories([], "排查 Wazuh 告警");

    expect(toolRouter.getTriageToolIds()).not.toContain("wazuh.alerts.search");
    expect(toolRouter.getDeepToolIds(categories)).toContain("wazuh.alerts.search");
  });

  it("combines all always-visible tools with inferred deferred tools in deep", () => {
    const registry = new ToolRegistry();
    registry.registerTools([
      pluginTool("secops_thirdparty_query", "thirdparty.query", "thirdparty-pack", false),
      pluginTool("secops_shuffle_workflow_list", "shuffle.workflow.list", "secops-shuffle")
    ]);

    toolRouter.build(registry);
    const deepIds = toolRouter.getDeepToolIds(["shuffle-soar"]);

    expect(deepIds).toContain("thirdparty.query");
    expect(deepIds).toContain("shuffle.workflow.list");
    expect(deepIds).not.toContain("report.generate");
  });

  it("reclassifies after plugin tools are registered on a later run", () => {
    const registry = new ToolRegistry();
    // 第一次 run：只有内置工具
    toolRouter.build(registry);
    expect(toolRouter.getTriageToolIds().length).toBeGreaterThan(0);

    // 插件安装 + reload 后：新工具注册进 registry，下一次 run 再次 build
    registry.registerTools([
      pluginTool("secops_wazuh_block_ip", "wazuh.block_ip", "wazuh-secops"),
      pluginTool("secops_thirdparty_query", "thirdparty.query", "thirdparty-pack")
    ]);
    toolRouter.build(registry);

    // wazuh 前缀工具应进入 wazuh-platform 类别（deep 阶段按类别加载）
    const wazuhIds = toolRouter.getSpecializedToolIds(["wazuh-platform"]);
    expect(wazuhIds).toContain("wazuh.block_ip");

    // 未知前缀的第三方插件工具应可见（triage 或 deep 任一可达）
    const allLoaded = toolRouter.getSpecializedToolIds([
      "core-triage",
      "wazuh-platform",
      "shuffle-soar",
      "reporting",
      "sandbox-actions"
    ]);
    expect(allLoaded).toContain("thirdparty.query");
  });
});
