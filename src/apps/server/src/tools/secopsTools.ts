import type { EvidenceArtifact, SkillManifest, ToolClass, ToolRisk } from "@secops-agent/shared";
import type { ModelTool } from "../providers/types.js";
import type { SecOpsTool, ToolContext, ToolExecutionResult } from "./types.js";

type ToolHandler = (args: Record<string, unknown>, context: ToolContext) => Promise<ToolExecutionResult>;

class BasicSecOpsTool implements SecOpsTool {
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

  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
    return this.handler(args, context);
  }
}

export function createSecOpsTools(): SecOpsTool[] {
  return [
    new BasicSecOpsTool(
      "secops_ioc_enrich",
      manifest({
        id: "ioc.enrich",
        name: "IOC Enrichment",
        description:
          "Classify an IP, domain, URL, or hash-like indicator with local deterministic context and defensive recommendations.",
        toolClass: "perception",
        risk: "low",
        tags: ["ioc", "triage", "read-only"],
        inputSchema: {
          type: "object",
          properties: {
            indicator: {
              type: "string",
              description: "Indicator to classify, such as an IP, domain, URL, or hash-like value."
            }
          },
          required: ["indicator"],
          additionalProperties: false
        }
      }),
      async (args) => {
        const indicator = requireString(args, "indicator");
        const result = enrichIndicator(indicator);
        return {
          output: result,
          artifacts: [
            artifact("ioc", `IOC: ${indicator}`, result.summary, result)
          ]
        };
      }
    ),
    new BasicSecOpsTool(
      "secops_detection_rule_search",
      manifest({
        id: "detection.rule.search",
        name: "Detection Rule Search",
        description:
          "Search a curated local library of defensive detection ideas by keyword or ATT&CK tactic.",
        toolClass: "reasoning",
        risk: "low",
        tags: ["detection", "sigma", "read-only"],
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Keyword, behavior, or data source to search for."
            },
            tactic: {
              type: "string",
              description: "Optional MITRE ATT&CK tactic filter."
            }
          },
          required: ["query"],
          additionalProperties: false
        }
      }),
      async (args) => {
        const query = requireString(args, "query");
        const tactic = typeof args.tactic === "string" ? args.tactic : undefined;
        const matches = searchRules(query, tactic);
        return {
          output: {
            query,
            tactic,
            count: matches.length,
            matches
          },
          artifacts: [
            artifact(
              "detection",
              `Detection search: ${query}`,
              `${matches.length} candidate defensive detections returned.`,
              matches
            )
          ]
        };
      }
    ),
    new BasicSecOpsTool(
      "secops_asset_inventory_lookup",
      manifest({
        id: "asset.inventory.lookup",
        name: "Asset Inventory Lookup",
        description:
          "Look up sample asset ownership, criticality, and containment notes for triage context.",
        toolClass: "perception",
        risk: "low",
        tags: ["asset", "ownership", "read-only"],
        inputSchema: {
          type: "object",
          properties: {
            asset: {
              type: "string",
              description: "Hostname, asset alias, or IP address to look up."
            }
          },
          required: ["asset"],
          additionalProperties: false
        }
      }),
      async (args) => {
        const asset = requireString(args, "asset");
        const result = lookupAsset(asset);
        return {
          output: result,
          artifacts: [
            artifact("asset", `Asset: ${asset}`, result.summary, result)
          ]
        };
      }
    ),
    new BasicSecOpsTool(
      "secops_case_evidence_pack",
      manifest({
        id: "case.evidence.pack",
        name: "Case Evidence Pack",
        description:
          "Create a compact evidence package from analyst observations for handoff or review.",
        toolClass: "evidence",
        risk: "low",
        tags: ["case", "evidence", "handoff"],
        inputSchema: {
          type: "object",
          properties: {
            caseTitle: {
              type: "string",
              description: "Short title for the case."
            },
            observations: {
              type: "array",
              items: { type: "string" },
              description: "Defensive observations to preserve."
            }
          },
          required: ["caseTitle", "observations"],
          additionalProperties: false
        }
      }),
      async (args) => {
        const caseTitle = requireString(args, "caseTitle");
        const observations = requireStringArray(args, "observations");
        const pack = {
          caseTitle,
          observationCount: observations.length,
          observations,
          reviewQuestions: [
            "Which assets and identities are in scope?",
            "What evidence supports severity?",
            "What action requires human approval?"
          ],
          createdBy: "secops-agent-console"
        };
        return {
          output: pack,
          artifacts: [
            artifact("case_note", caseTitle, `${observations.length} observations packaged.`, pack)
          ]
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
    skillPackId: "secops-core",
    defaultPermission: "auto",
    mcpCompatible: true
  };
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Expected non-empty string argument: ${key}`);
  }
  return value.trim();
}

function requireStringArray(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Expected string array argument: ${key}`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function artifact(
  kind: EvidenceArtifact["kind"],
  title: string,
  summary: string,
  data: unknown
): EvidenceArtifact {
  return {
    id: crypto.randomUUID(),
    kind,
    title,
    summary,
    data,
    createdAt: new Date().toISOString()
  };
}

function enrichIndicator(indicator: string) {
  const isDocumentationIp = /^(192\.0\.2|198\.51\.100|203\.0\.113)\./.test(indicator);
  const isHashLike = /^[a-f0-9]{32,64}$/i.test(indicator);
  const isDomain = /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(indicator);
  const score = isHashLike ? 54 : isDomain ? 42 : isDocumentationIp ? 12 : 34;
  const type = isHashLike ? "hash" : isDomain ? "domain" : "network";
  return {
    indicator,
    type,
    riskScore: score,
    confidence: isDocumentationIp ? "low-sample" : "medium-local",
    summary: `${indicator} classified as ${type} with risk score ${score}.`,
    recommendedActions: [
      "Correlate with endpoint and identity telemetry.",
      "Check first-seen and last-seen timestamps.",
      "Escalate only with corroborating evidence."
    ],
    dataSources: ["local heuristics", "sample SecOps knowledge base"]
  };
}

const detectionRules = [
  {
    name: "Suspicious impossible travel login",
    tactic: "credential-access",
    dataSources: ["identity_provider", "vpn"],
    logic: "Same identity authenticates from distant geographies within a short interval.",
    response: "Validate MFA posture and recent password reset activity."
  },
  {
    name: "Endpoint launches unsigned administrative tool",
    tactic: "execution",
    dataSources: ["edr_process", "file_reputation"],
    logic: "Administrative binary starts from a user-writable path with unknown signature.",
    response: "Collect process tree, signer data, and parent command line."
  },
  {
    name: "High-volume outbound DNS to new domain",
    tactic: "command-and-control",
    dataSources: ["dns", "proxy"],
    logic: "Host produces repeated lookups for a domain first seen in the last day.",
    response: "Compare against business owner and isolate only after confirmation."
  },
  {
    name: "Privilege change outside maintenance window",
    tactic: "privilege-escalation",
    dataSources: ["iam", "audit_log"],
    logic: "Role membership changes outside the approved change window.",
    response: "Confirm ticket linkage and review actor session history."
  }
];

function searchRules(query: string, tactic?: string) {
  const terms = `${query} ${tactic ?? ""}`.toLowerCase().split(/\W+/).filter(Boolean);
  return detectionRules
    .map((rule) => ({
      ...rule,
      score: terms.filter((term) => JSON.stringify(rule).toLowerCase().includes(term)).length
    }))
    .filter((rule) => rule.score > 0 || !terms.length)
    .sort((left, right) => right.score - left.score)
    .slice(0, 3);
}

const sampleAssets = [
  {
    aliases: ["workstation-042", "198.51.100.23"],
    owner: "Finance Operations",
    criticality: "medium",
    summary: "Finance workstation with normal business-hour activity profile.",
    containmentNote: "Human approval required before isolation during payroll windows."
  },
  {
    aliases: ["idp-prod-01", "auth"],
    owner: "Identity Platform",
    criticality: "high",
    summary: "Production identity provider node.",
    containmentNote: "No automated containment; escalate to identity on-call."
  }
];

function lookupAsset(asset: string) {
  const normalized = asset.toLowerCase();
  const match = sampleAssets.find((item) => item.aliases.some((alias) => alias.toLowerCase() === normalized));
  if (match) {
    return {
      asset,
      found: true,
      owner: match.owner,
      criticality: match.criticality,
      summary: match.summary,
      containmentNote: match.containmentNote
    };
  }
  return {
    asset,
    found: false,
    owner: "unknown",
    criticality: "unknown",
    summary: "No matching sample asset found.",
    containmentNote: "Do not take automated action without ownership confirmation."
  };
}
