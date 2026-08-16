import type { SkillSummary, ToolManifest } from "@secops-agent/shared";
import type { PluginManager } from "../plugins/pluginManager.js";
import type { SkillCatalog } from "../skills/catalog.js";
import type { ModelTool } from "../providers/types.js";
import type { SecOpsTool, ToolContext, ToolExecutionResult } from "./types.js";

const manifest: ToolManifest = {
  id: "plugins.manage",
  name: "Manage Plugins",
  description:
    "List installed plugins and loaded skills, inspect one plugin's MCP servers and skill ids, or read full skill content. Call this before answering which plugins/skills are installed, or before saying a plugin is missing or unavailable.",
  toolClass: "perception",
  risk: "low",
  deferLoading: false,
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "inspect", "read_skill"],
        description:
          "list: list all installed plugins and loaded skills. inspect: show one plugin's MCP servers, tool/skill counts and skill ids. read_skill: read full content of a skill by id."
      },
      id: {
        type: "string",
        description: "Plugin id for inspect, or skill id for read_skill."
      }
    },
    required: ["action"],
    additionalProperties: false
  },
  tags: ["plugins", "skills", "read-only"],
  mcpCompatible: false
};

export function createPluginManageTool(
  pluginManager: PluginManager,
  skillCatalog: SkillCatalog
): SecOpsTool {
  return {
    apiName: "secops_plugins_manage",
    manifest,
    toModelTool(): ModelTool {
      return {
        type: "function",
        function: {
          name: "secops_plugins_manage",
          description: manifest.description,
          parameters: manifest.inputSchema
        }
      };
    },
    async execute(args: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
      const action = typeof args.action === "string" ? args.action.trim() : "";
      const id = typeof args.id === "string" ? args.id.trim() : "";

      if (action === "list") {
        return {
          output: {
            plugins: pluginManager.status(),
            skills: skillCatalog.list()
          }
        };
      }

      if (action === "inspect") {
        if (!id) {
          throw new Error("Plugin id is required for inspect action");
        }
        const plugin = pluginManager.status().find((candidate) => candidate.id === id);
        if (!plugin) {
          throw new Error(`Plugin ${id} is not installed`);
        }
        const skills = skillCatalog.list().filter((skill) => skill.pluginId === id);
        return {
          output: {
            ...plugin,
            skills: skills.map(summarizeSkill)
          }
        };
      }

      if (action === "read_skill") {
        if (!id) {
          throw new Error("Skill id is required for read_skill action");
        }
        const skill = skillCatalog.read(id);
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

      throw new Error(`Unsupported plugin manage action: ${action || "(empty)"}`);
    }
  };
}

function summarizeSkill(skill: SkillSummary) {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    status: skill.status,
    enabled: skill.enabled,
    ...(skill.pluginId ? { pluginId: skill.pluginId } : {}),
    ...(skill.error ? { error: skill.error } : {})
  };
}

