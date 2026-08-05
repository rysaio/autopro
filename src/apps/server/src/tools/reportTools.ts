import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { EvidenceArtifact, SkillManifest, ToolClass, ToolRisk } from "@secops-agent/shared";
import type { ModelTool } from "../providers/types.js";
import type { SecOpsTool, ToolContext, ToolExecutionResult } from "./types.js";

type ToolHandler = (args: Record<string, unknown>, context: ToolContext) => Promise<ToolExecutionResult>;

class ReportTool implements SecOpsTool {
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

export interface IncidentReport {
  reportId: string;
  sessionId: string;
  title: string;
  severity: "low" | "medium" | "high" | "critical";
  generatedAt: string;
  executiveSummary: string;
  timeline: Array<{
    time: string;
    event: string;
    source: string;
    type: string;
  }>;
  iocFindings: Array<{
    indicator: string;
    type: string;
    riskScore: number;
    confidence: string;
    summary: string;
  }>;
  mitreMapping: Array<{
    tactic: string;
    technique: string;
    description: string;
  }>;
  evidenceSummary: {
    totalArtifacts: number;
    byType: Record<string, number>;
    keyFindings: string[];
  };
  recommendations: string[];
  artifacts: EvidenceArtifact[];
  toolInvocations: Array<{
    toolName: string;
    status: string;
    risk: string;
    summary: string;
  }>;
}

export function createReportTools(): SecOpsTool[] {
  return [
    new ReportTool(
      "secops_report_generate",
      reportManifest({
        id: "report.generate",
        name: "Generate Incident Report",
        description:
          "Generate a structured incident report from session data including executive summary, timeline, IOC findings, MITRE ATT&CK mapping, evidence summary, and recommendations.",
        toolClass: "evidence",
        risk: "low",
        tags: ["report", "evidence", "incident", "read-only"],
        inputSchema: {
          type: "object",
          properties: {
            sessionId: {
              type: "string",
              description: "Session identifier to generate the report from."
            },
            reportTitle: {
              type: "string",
              description: "Title for the incident report."
            },
            severity: {
              type: "string",
              enum: ["low", "medium", "high", "critical"],
              description: "Severity level of the incident."
            },
            toolInvocations: {
              type: "array",
              items: { type: "object" },
              description: "Tool invocations from the session."
            },
            artifacts: {
              type: "array",
              items: { type: "object" },
              description: "Evidence artifacts from the session."
            },
            messages: {
              type: "array",
              items: { type: "object" },
              description: "Chat messages from the session."
            }
          },
          required: ["sessionId", "reportTitle", "severity"],
          additionalProperties: false
        }
      }),
      async (args, context) => {
        const sessionId = requireString(args, "sessionId");
        const reportTitle = requireString(args, "reportTitle");
        const severity = coerceSeverity(args.severity);
        const rawToolInvocations = Array.isArray(args.toolInvocations) ? args.toolInvocations as Record<string, unknown>[] : [];
        const rawArtifacts = Array.isArray(args.artifacts) ? args.artifacts as Record<string, unknown>[] : [];
        const rawMessages = Array.isArray(args.messages) ? args.messages as Array<{ role?: string; content?: string }> : [];

        const reportId = crypto.randomUUID();
        const now = new Date().toISOString();

        const timeline = buildTimeline(rawMessages, rawToolInvocations);
        const iocFindings = extractIocFindings(rawArtifacts);
        const mitreMapping = buildMitreMapping(rawToolInvocations, rawArtifacts);
        const evidenceSummary = buildEvidenceSummary(rawArtifacts);
        const recommendations = buildRecommendations(severity, iocFindings, mitreMapping);

        const toolInvocationSummaries = rawToolInvocations.map((inv) => ({
          toolName: String(inv.toolName ?? inv.displayName ?? "unknown"),
          status: String(inv.status ?? "unknown"),
          risk: String(inv.risk ?? "low"),
          summary: inv.guidance
            ? `Guidance: ${String((inv.guidance as Record<string, unknown>)?.message ?? "")}`
            : inv.error
              ? `Error: ${String(inv.error)}`
              : `Completed`
        }));

        const executiveSummary = buildExecutiveSummary(reportTitle, severity, timeline, iocFindings, mitreMapping);

        const report: IncidentReport = {
          reportId,
          sessionId,
          title: reportTitle,
          severity,
          generatedAt: now,
          executiveSummary,
          timeline,
          iocFindings,
          mitreMapping,
          evidenceSummary,
          recommendations,
          artifacts: rawArtifacts as unknown as EvidenceArtifact[],
          toolInvocations: toolInvocationSummaries
        };

        const reportsDir = path.join(context.sandboxRoot, "reports");
        await mkdir(reportsDir, { recursive: true });
        const reportPath = path.join(reportsDir, `incident-report-${reportId}.json`);
        await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");

        return {
          output: {
            reportId,
            reportPath,
            report
          },
          artifacts: [
            reportArtifact(
              "case_note",
              `Incident Report: ${reportTitle}`,
              `Report generated with ${iocFindings.length} IOCs, ${mitreMapping.length} MITRE mappings, ${evidenceSummary.totalArtifacts} artifacts.`,
              report
            )
          ]
        };
      }
    ),
    new ReportTool(
      "secops_report_export",
      reportManifest({
        id: "report.export",
        name: "Export Incident Report",
        description:
          "Export a previously generated incident report in markdown or JSON format.",
        toolClass: "evidence",
        risk: "low",
        tags: ["report", "export", "read-only"],
        inputSchema: {
          type: "object",
          properties: {
            sessionId: {
              type: "string",
              description: "Session identifier to locate the report."
            },
            format: {
              type: "string",
              enum: ["markdown", "json"],
              description: "Export format: 'markdown' or 'json'."
            },
            reportData: {
              type: "object",
              description: "The report data to export (from generate report output)."
            }
          },
          required: ["sessionId", "format"],
          additionalProperties: false
        }
      }),
      async (args) => {
        const format = coerceFormat(args.format);
        const reportData = args.reportData as IncidentReport | undefined;

        if (!reportData) {
          throw new Error("reportData is required for export");
        }

        let exported: string;
        let mimeType: string;

        if (format === "json") {
          exported = JSON.stringify(reportData, null, 2);
          mimeType = "application/json";
        } else {
          exported = renderMarkdownReport(reportData);
          mimeType = "text/markdown";
        }

        return {
          output: {
            format,
            mimeType,
            content: exported,
            title: reportData.title
          },
          artifacts: [
            reportArtifact(
              "case_note",
              `Exported Report: ${reportData.title}`,
              `Report exported in ${format} format.`,
              { format, content: exported.slice(0, 500) + (exported.length > 500 ? "..." : "") }
            )
          ]
        };
      }
    )
  ];
}

function reportManifest(input: {
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
    skillPackId: "secops-reports",
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

function coerceSeverity(value: unknown): "low" | "medium" | "high" | "critical" {
  if (value === "low" || value === "medium" || value === "high" || value === "critical") {
    return value;
  }
  return "medium";
}

function coerceFormat(value: unknown): "markdown" | "json" {
  if (value === "markdown" || value === "json") {
    return value;
  }
  return "markdown";
}

function reportArtifact(
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

function buildTimeline(
  messages: Array<{ role?: string; content?: string }>,
  toolInvocations: Record<string, unknown>[]
): IncidentReport["timeline"] {
  const entries: IncidentReport["timeline"] = [];

  for (const msg of messages) {
    const role = String(msg.role ?? "unknown");
    const content = String(msg.content ?? "").slice(0, 200);
    entries.push({
      time: String((msg as Record<string, unknown>).createdAt ?? (msg as Record<string, unknown>).timestamp ?? new Date().toISOString()),
      event: content || `${role} message`,
      source: role,
      type: "message"
    });
  }

  for (const inv of toolInvocations) {
    const toolName = String(inv.toolName ?? inv.displayName ?? "unknown");
    const status = String(inv.status ?? "unknown");
    entries.push({
      time: String(inv.completedAt ?? inv.startedAt ?? new Date().toISOString()),
      event: `${toolName} - ${status}`,
      source: "tool",
      type: status
    });
  }

  return entries;
}

function extractIocFindings(rawArtifacts: Record<string, unknown>[]): IncidentReport["iocFindings"] {
  return rawArtifacts
    .filter((a) => a.kind === "ioc")
    .map((a) => {
      const data = (a.data as Record<string, unknown>) ?? {};
      return {
        indicator: String(data.indicator ?? a.title ?? "unknown"),
        type: String(data.type ?? "unknown"),
        riskScore: Number(data.riskScore ?? 0),
        confidence: String(data.confidence ?? "unknown"),
        summary: String(a.summary ?? "")
      };
    });
}

function buildMitreMapping(
  rawToolInvocations: Record<string, unknown>[],
  rawArtifacts: Record<string, unknown>[]
): IncidentReport["mitreMapping"] {
  const tacticMap: Record<string, string> = {
    "credential-access": "Credential Access (TA0006)",
    "execution": "Execution (TA0002)",
    "command-and-control": "Command and Control (TA0011)",
    "privilege-escalation": "Privilege Escalation (TA0004)",
    "initial-access": "Initial Access (TA0001)",
    "persistence": "Persistence (TA0003)",
    "defense-evasion": "Defense Evasion (TA0005)",
    "discovery": "Discovery (TA0007)",
    "lateral-movement": "Lateral Movement (TA0008)",
    "collection": "Collection (TA0009)",
    "exfiltration": "Exfiltration (TA0010)",
    "impact": "Impact (TA0040)"
  };

  const seen = new Set<string>();
  const mappings: IncidentReport["mitreMapping"] = [];

  for (const a of rawArtifacts) {
    if (a.kind !== "detection") continue;
    const data = (a.data as Record<string, unknown>) ?? {};
    const matches = Array.isArray(data.matches) ? data.matches as Record<string, unknown>[] : [];
    for (const match of matches) {
      const tactic = String(match.tactic ?? "");
      const name = String(match.name ?? "");
      const key = `${tactic}:${name}`;
      if (tactic && !seen.has(key)) {
        seen.add(key);
        mappings.push({
          tactic: tacticMap[tactic] ?? tactic,
          technique: name,
          description: String(match.response ?? match.logic ?? "")
        });
      }
    }
  }

  for (const inv of rawToolInvocations) {
    const toolName = String(inv.toolName ?? "");
    if (toolName.includes("detection") || toolName.includes("rule")) {
      const result = inv.result as Record<string, unknown> | undefined;
      if (result?.tactic) {
        const tactic = String(result.tactic);
        const key = `${tactic}:detection-search`;
        if (!seen.has(key)) {
          seen.add(key);
          mappings.push({
            tactic: tacticMap[tactic] ?? tactic,
            technique: "Detection Rule Search",
            description: String(result.query ?? "Detection search performed")
          });
        }
      }
    }
  }

  return mappings;
}

function buildEvidenceSummary(rawArtifacts: Record<string, unknown>[]) {
  const byType: Record<string, number> = {};
  const keyFindings: string[] = [];

  for (const a of rawArtifacts) {
    const kind = String(a.kind ?? "unknown");
    byType[kind] = (byType[kind] ?? 0) + 1;
    if (a.summary && typeof a.summary === "string") {
      keyFindings.push(a.summary);
    }
  }

  return {
    totalArtifacts: rawArtifacts.length,
    byType,
    keyFindings: keyFindings.slice(0, 10)
  };
}

function buildRecommendations(
  severity: string,
  iocFindings: IncidentReport["iocFindings"],
  mitreMapping: IncidentReport["mitreMapping"]
): string[] {
  const recommendations: string[] = [
    "Conduct a full review of all affected systems and assets.",
    "Correlate findings with endpoint detection and response (EDR) telemetry."
  ];

  if (severity === "high" || severity === "critical") {
    recommendations.push(
      "Escalate to incident response team immediately.",
      "Initiate containment procedures for affected assets.",
      "Preserve forensic evidence including memory dumps and disk images."
    );
  }

  if (iocFindings.length > 0) {
    recommendations.push(
      `Block or monitor ${iocFindings.length} identified indicators of compromise.`,
      "Update SIEM rules and threat intelligence feeds with identified IOCs."
    );
  }

  if (mitreMapping.length > 0) {
    recommendations.push(
      `Review defenses against ${mitreMapping.length} mapped MITRE ATT&CK techniques.`,
      "Conduct a gap analysis for covered MITRE ATT&CK tactics."
    );
  }

  recommendations.push(
    "Document all findings and actions in the case management system.",
    "Schedule a post-incident review within 48 hours."
  );

  return recommendations;
}

function buildExecutiveSummary(
  title: string,
  severity: string,
  timeline: IncidentReport["timeline"],
  iocFindings: IncidentReport["iocFindings"],
  mitreMapping: IncidentReport["mitreMapping"]
): string {
  const messageCount = timeline.filter((t) => t.type === "message").length;
  const toolCount = timeline.filter((t) => t.source === "tool").length;
  const failedTools = timeline.filter((t) => t.type === "failed").length;

  return [
    `Incident Report: ${title}`,
    `Severity: ${severity.toUpperCase()}`,
    `Generated at: ${new Date().toISOString()}`,
    ``,
    `Overview: This investigation involved ${messageCount} message exchanges and ${toolCount} tool invocations.`,
    `${iocFindings.length} indicators of compromise were identified across the session.`,
    `${mitreMapping.length} MITRE ATT&CK techniques were mapped to findings.`,
    failedTools > 0 ? `${failedTools} tool invocations failed during the investigation.` : "All tool invocations completed successfully.",
    ``,
    `The investigation identified ${iocFindings.length} IOCs with risk scores ranging from ${iocFindings.length > 0 ? Math.min(...iocFindings.map((i) => i.riskScore)) : 0} to ${iocFindings.length > 0 ? Math.max(...iocFindings.map((i) => i.riskScore)) : 0}.`,
    `Primary MITRE ATT&CK tactics involved: ${mitreMapping.map((m) => m.tactic.split(" (")[0]).filter((v, i, a) => a.indexOf(v) === i).join(", ") || "None identified"}.`
  ].join("\n");
}

function renderMarkdownReport(report: IncidentReport): string {
  const lines: string[] = [];

  lines.push(`# ${report.title}`);
  lines.push("");
  lines.push(`**Report ID:** ${report.reportId}`);
  lines.push(`**Session ID:** ${report.sessionId}`);
  lines.push(`**Severity:** ${report.severity.toUpperCase()}`);
  lines.push(`**Generated:** ${report.generatedAt}`);
  lines.push("");

  lines.push("## Executive Summary");
  lines.push("");
  lines.push(report.executiveSummary);
  lines.push("");

  lines.push("## Timeline");
  lines.push("");
  if (report.timeline.length > 0) {
    lines.push("| Time | Event | Source | Type |");
    lines.push("|------|-------|--------|------|");
    for (const entry of report.timeline.slice(0, 50)) {
      lines.push(`| ${entry.time.slice(0, 19)} | ${entry.event.slice(0, 80)} | ${entry.source} | ${entry.type} |`);
    }
  } else {
    lines.push("No timeline entries recorded.");
  }
  lines.push("");

  lines.push("## IOC Findings");
  lines.push("");
  if (report.iocFindings.length > 0) {
    lines.push("| Indicator | Type | Risk Score | Confidence | Summary |");
    lines.push("|-----------|------|------------|------------|---------|");
    for (const ioc of report.iocFindings) {
      lines.push(`| ${ioc.indicator} | ${ioc.type} | ${ioc.riskScore} | ${ioc.confidence} | ${ioc.summary.slice(0, 60)} |`);
    }
  } else {
    lines.push("No IOCs identified.");
  }
  lines.push("");

  lines.push("## MITRE ATT&CK Mapping");
  lines.push("");
  if (report.mitreMapping.length > 0) {
    lines.push("| Tactic | Technique | Description |");
    lines.push("|--------|-----------|-------------|");
    for (const mapping of report.mitreMapping) {
      lines.push(`| ${mapping.tactic} | ${mapping.technique} | ${mapping.description.slice(0, 80)} |`);
    }
  } else {
    lines.push("No MITRE ATT&CK mappings available.");
  }
  lines.push("");

  lines.push("## Evidence Summary");
  lines.push("");
  lines.push(`- **Total Artifacts:** ${report.evidenceSummary.totalArtifacts}`);
  lines.push("- **By Type:**");
  for (const [kind, count] of Object.entries(report.evidenceSummary.byType)) {
    lines.push(`  - ${kind}: ${count}`);
  }
  lines.push("- **Key Findings:**");
  for (const finding of report.evidenceSummary.keyFindings.slice(0, 5)) {
    lines.push(`  - ${finding}`);
  }
  lines.push("");

  lines.push("## Recommendations");
  lines.push("");
  for (const rec of report.recommendations) {
    lines.push(`- ${rec}`);
  }
  lines.push("");

  lines.push("## Tool Invocations");
  lines.push("");
  lines.push("| Tool | Status | Risk | Summary |");
  lines.push("|------|--------|------|---------|");
  for (const inv of report.toolInvocations) {
    lines.push(`| ${inv.toolName} | ${inv.status} | ${inv.risk} | ${inv.summary.slice(0, 60)} |`);
  }
  lines.push("");

  lines.push("---");
  lines.push(`*Report generated by SecOps Agent at ${report.generatedAt}*`);

  return lines.join("\n");
}
