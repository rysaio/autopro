import type { ToolManifest } from "@secops-agent/shared";
import type { ModelTool } from "../providers/types.js";
import type { SecOpsTool, ToolContext, ToolExecutionResult } from "../tools/types.js";
import type { SkillCatalog } from "./catalog.js";

const manifest: ToolManifest = {
  id: "skill.read",
  name: "Read Skill",
  description: "Read the full body of a named Skill after its summary indicates it is relevant.",
  toolClass: "perception",
  risk: "low",
  deferLoading: false,
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Skill id from the available skills list." }
    },
    required: ["id"],
    additionalProperties: false
  },
  tags: ["skills", "read-only"],
  mcpCompatible: false
};

export function createSkillReadTool(catalog: SkillCatalog): SecOpsTool {
  return {
    apiName: "secops_skill_read",
    manifest,
    toModelTool(): ModelTool {
      return {
        type: "function",
        function: {
          name: "secops_skill_read",
          description: manifest.description,
          parameters: manifest.inputSchema
        }
      };
    },
    async execute(args: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
      const id = typeof args.id === "string" ? args.id.trim() : "";
      if (!id) {
        throw new Error("Skill id is required");
      }
      const skill = catalog.read(id);
      if (!skill) {
        throw new Error(`Skill ${id} is not available`);
      }
      return {
        output: {
          id: skill.id,
          name: skill.name,
          description: skill.description,
          source: skill.source,
          ...(skill.pluginId ? { pluginId: skill.pluginId } : {}),
          content: skill.content
        }
      };
    }
  };
}
