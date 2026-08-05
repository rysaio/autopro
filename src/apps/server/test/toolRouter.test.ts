import { describe, expect, it } from "vitest";
import type { ModelTool } from "../src/providers/types.js";
import { toolRouter } from "../src/runtime/toolRouter.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { SecOpsTool, ToolContext, ToolExecutionResult } from "../src/tools/types.js";

function pluginTool(apiName: string, manifestId: string, packId: string): SecOpsTool {
  return {
    apiName,
    manifest: {
      id: manifestId,
      skillPackId: packId,
      name: manifestId,
      description: "Plugin tool.",
      toolClass: "perception",
      risk: "low",
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
