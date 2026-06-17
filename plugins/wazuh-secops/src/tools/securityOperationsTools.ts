import type { WazuhIndexerClient } from "../core/indexerClient.js";
import type { WazuhClient } from "../core/wazuhClient.js";
import { networkExposureMap, ruleHitsSummary } from "../workflows/securityOperations.js";
import { artifact } from "./helpers.js";
import type { ModelTool, SkillManifest, ToolClass, ToolRisk, WazuhExecutionContext, WazuhExecutionResult, WazuhPluginTool } from "./types.js";

type ToolHandler = (args: Record<string, unknown>, context: WazuhExecutionContext) => Promise<WazuhExecutionResult>;

class WazuhTool implements WazuhPluginTool {
  constructor(
    readonly apiName: string,
    readonly manifest: SkillManifest,
    private readonly handler: ToolHandler
  ) {}

  toModelTool(): ModelTool {
    return {
      type: "function",
      function: {
        name: this.apiName,
        description: this.manifest.description,
        parameters: this.manifest.inputSchema
      }
    };
  }

  execute(args: Record<string, unknown>, context: WazuhExecutionContext): Promise<WazuhExecutionResult> {
    return this.handler(args, context);
  }
}

export function createSecurityOperationsTools(
  clientFactory: () => WazuhClient,
  indexerClientFactory: () => WazuhIndexerClient
): WazuhPluginTool[] {
  return [
    new WazuhTool(
      "secops_wazuh_network_exposure_map",
      manifest({
        id: "wazuh.network.exposure.map",
        name: "Map Wazuh Network Exposure",
        description:
          "Build a bounded exposure map from Wazuh agents, syscollector addresses, and listening ports.",
        toolClass: "perception",
        risk: "low",
        tags: ["wazuh", "syscollector", "network", "exposure", "read-only"],
        inputSchema: {
          type: "object",
          properties: {
            status: {
              type: "string",
              enum: ["active", "disconnected", "never_connected", "pending"],
              description: "Optional Wazuh agent connection status filter."
            },
            agentLimit: { type: "number", description: "Maximum agents to scan, from 1 to 200." },
            portLimit: { type: "number", description: "Maximum listening ports per agent, from 1 to 500." }
          },
          required: [],
          additionalProperties: false
        }
      }),
      async (args) => {
        const request = networkExposureRequest(args);
        const output = await networkExposureMap(clientFactory(), request);
        return {
          output,
          artifacts: [artifact("Wazuh network exposure map", "Mapped Wazuh syscollector network exposure.", output)]
        };
      }
    ),
    new WazuhTool(
      "secops_wazuh_rule_hits_summary",
      manifest({
        id: "wazuh.rule.hits.summary",
        name: "Summarize Wazuh Rule Hits",
        description:
          "Summarize recent Wazuh alert rule activity by rule id, level, agent, and group from a bounded Indexer search.",
        toolClass: "perception",
        risk: "low",
        tags: ["wazuh", "alerts", "rules", "summary", "read-only"],
        inputSchema: {
          type: "object",
          properties: {
            timeWindowMinutes: { type: "number", description: "Recent alert lookback window in minutes, from 1 to 10080." },
            limit: { type: "number", description: "Maximum alerts to inspect, from 1 to 200." },
            minimumLevel: { type: "number", description: "Optional minimum Wazuh rule level, from 0 to 16." }
          },
          required: [],
          additionalProperties: false
        }
      }),
      async (args) => {
        const request = ruleHitsRequest(args);
        const output = await ruleHitsSummary(indexerClientFactory(), request);
        return {
          output,
          artifacts: [artifact("Wazuh rule hits summary", "Summarized recent Wazuh alert rule activity.", output)]
        };
      }
    )
  ];
}

function manifest(input: {
  id: string;
  name: string;
  description: string;
  toolClass: ToolClass;
  risk: ToolRisk;
  tags: string[];
  inputSchema: SkillManifest["inputSchema"];
}): SkillManifest {
  return {
    ...input,
    skillPackId: "secops-wazuh",
    defaultPermission: input.toolClass === "action" ? "ask" : "auto",
    mcpCompatible: true
  };
}

function networkExposureRequest(args: Record<string, unknown>) {
  const request: {
    status?: string;
    agentLimit: number;
    portLimit: number;
  } = {
    agentLimit: boundedInteger(args, "agentLimit", 50, 1, 200),
    portLimit: boundedInteger(args, "portLimit", 100, 1, 500)
  };
  const status = optionalString(args, "status");
  if (status) {
    request.status = status;
  }
  return request;
}

function ruleHitsRequest(args: Record<string, unknown>) {
  const request: {
    timeWindowMinutes: number;
    limit: number;
    minimumLevel?: number;
  } = {
    timeWindowMinutes: boundedInteger(args, "timeWindowMinutes", 60, 1, 10_080),
    limit: boundedInteger(args, "limit", 100, 1, 200)
  };
  const minimumLevel = optionalNumber(args, "minimumLevel");
  if (minimumLevel !== undefined) {
    if (!Number.isInteger(minimumLevel) || minimumLevel < 0 || minimumLevel > 16) {
      throw new Error("minimumLevel must be an integer from 0 to 16");
    }
    request.minimumLevel = minimumLevel;
  }
  return request;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim().length ? value.trim() : undefined;
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function boundedInteger(args: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const value = optionalNumber(args, key) ?? fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${key} must be an integer from ${min} to ${max}`);
  }
  return value;
}
