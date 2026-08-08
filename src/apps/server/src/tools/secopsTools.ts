import type { EvidenceArtifact, SkillManifest, ToolClass, ToolRisk } from "@secops-agent/shared";
import type { ModelTool } from "../providers/types.js";
import type { SecOpsTool, ToolContext, ToolExecutionResult } from "./types.js";
import {
  lookupThreatIntel,
  searchMitreAttack,
  getMitreTechniqueById,
  getTriagePlaybook,
  getMaliciousIpRisk,
  suspiciousPortPatterns,
  maliciousAsnPatterns,
  geolocationRiskHints,
  mitreAttackTechniques
} from "./threatIntel.js";

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
    // ============================================================
    // 1. secops_ioc_enrich (ENHANCED)
    // ============================================================
    new BasicSecOpsTool(
      "secops_ioc_enrich",
      manifest({
        id: "ioc.enrich",
        name: "IOC Enrichment",
        description:
          "Classify an IP, domain, URL, or hash-like indicator with local deterministic context, threat intelligence, MITRE ATT&CK technique mapping, and defensive recommendations.",
        toolClass: "perception",
        risk: "low",
        tags: ["ioc", "triage", "read-only", "threat-intel", "mitre"],
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

    // ============================================================
    // 2. secops_detection_rule_search (ENHANCED)
    // ============================================================
    new BasicSecOpsTool(
      "secops_detection_rule_search",
      manifest({
        id: "detection.rule.search",
        name: "Detection Rule Search",
        description:
          "Search a curated local library of defensive detection ideas by keyword, ATT&CK tactic, or technique ID. Returns matched rules with technique IDs.",
        toolClass: "reasoning",
        risk: "low",
        tags: ["detection", "sigma", "read-only", "mitre"],
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Keyword, behavior, technique ID, or data source to search for."
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

    // ============================================================
    // 3. secops_asset_inventory_lookup (ENHANCED)
    // ============================================================
    new BasicSecOpsTool(
      "secops_asset_inventory_lookup",
      manifest({
        id: "asset.inventory.lookup",
        name: "Asset Inventory Lookup",
        description:
          "Look up sample asset ownership, criticality, network segment, department, business context, and containment notes for triage context.",
        toolClass: "perception",
        risk: "low",
        tags: ["asset", "ownership", "read-only", "network-segment"],
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

    // ============================================================
    // 4. secops_case_evidence_pack (unchanged)
    // ============================================================
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
    ),

    // ============================================================
    // 5. secops_threat_intel_lookup (NEW)
    // ============================================================
    new BasicSecOpsTool(
      "secops_threat_intel_lookup",
      manifest({
        id: "threat.intel.lookup",
        name: "Threat Intelligence Lookup",
        description:
          "Look up threat intelligence for an IP, domain, URL, or hash from the local knowledge base. Returns threat category, severity, known campaigns, MITRE ATT&CK techniques, and associated IOCs.",
        toolClass: "perception",
        risk: "low",
        tags: ["threat-intel", "ioc", "read-only", "mitre"],
        inputSchema: {
          type: "object",
          properties: {
            indicator: {
              type: "string",
              description: "IP address, domain, URL, or file hash to look up in threat intelligence."
            }
          },
          required: ["indicator"],
          additionalProperties: false
        }
      }),
      async (args) => {
        const indicator = requireString(args, "indicator");
        const intel = lookupThreatIntel(indicator);
        if (intel) {
          const mitreDetails = intel.mitreTechniques
            .map((tid) => getMitreTechniqueById(tid))
            .filter(Boolean);
          const result = {
            indicator,
            found: true,
            type: intel.type,
            category: intel.category,
            severity: intel.severity,
            description: intel.description,
            firstSeen: intel.firstSeen,
            tags: intel.tags,
            mitreTechniques: intel.mitreTechniques,
            mitreDetails,
            summary: `${indicator} is a known ${intel.category} indicator with ${intel.severity} severity.`
          };
          return {
            output: result,
            artifacts: [
              artifact("ioc", `Threat Intel: ${indicator}`, result.summary, result)
            ]
          };
        }
        const notFound = {
          indicator,
          found: false,
          summary: `${indicator} was not found in the local threat intelligence knowledge base. Consider external enrichment.`,
          recommendation: "Search for this indicator in external threat intelligence platforms (VirusTotal, AlienVault OTX, AbuseIPDB)."
        };
        return {
          output: notFound,
          artifacts: [
            artifact("ioc", `Threat Intel: ${indicator}`, notFound.summary, notFound)
          ]
        };
      }
    ),

    // ============================================================
    // 6. secops_mitre_attack_search (NEW)
    // ============================================================
    new BasicSecOpsTool(
      "secops_mitre_attack_search",
      manifest({
        id: "mitre.attack.search",
        name: "MITRE ATT&CK Search",
        description:
          "Search the MITRE ATT&CK knowledge base by technique ID (e.g., T1059), tactic name, keyword, platform, or data source. Returns matching techniques with detection and mitigation guidance.",
        toolClass: "reasoning",
        risk: "low",
        tags: ["mitre", "attack", "read-only", "detection", "ttps"],
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Technique ID (e.g., T1059), tactic, keyword, platform, or data source to search for."
            },
            tactic: {
              type: "string",
              description: "Optional tactic filter (e.g., execution, persistence, defense-evasion)."
            }
          },
          required: ["query"],
          additionalProperties: false
        }
      }),
      async (args) => {
        const query = requireString(args, "query");
        const tactic = typeof args.tactic === "string" ? args.tactic : undefined;

        // Check if query is a direct technique ID
        const directMatch = getMitreTechniqueById(query);
        if (directMatch) {
          return {
            output: {
              query,
              tactic,
              exactMatch: true,
              count: 1,
              techniques: [directMatch]
            },
            artifacts: [
              artifact("ioc", `MITRE ATT&CK: ${query}`, `Found technique ${directMatch.id}: ${directMatch.name}`, directMatch)
            ]
          };
        }

        let results = searchMitreAttack(query);
        if (tactic) {
          results = results.filter((t) => t.tactic.toLowerCase() === tactic.toLowerCase());
        }
        return {
          output: {
            query,
            tactic,
            exactMatch: false,
            count: results.length,
            techniques: results
          },
          artifacts: [
            artifact("detection", `MITRE ATT&CK search: ${query}`, `${results.length} techniques matched.`, results)
          ]
        };
      }
    ),

    // ============================================================
    // 7. secops_alert_triage_playbook (NEW)
    // ============================================================
    new BasicSecOpsTool(
      "secops_alert_triage_playbook",
      manifest({
        id: "alert.triage.playbook",
        name: "Alert Triage Playbook",
        description:
          "Return a guided triage playbook for a specific alert type (brute_force, malware, phishing, data_exfiltration, lateral_movement, privilege_escalation). Includes step-by-step investigation actions, escalation criteria, containment actions, and investigation questions.",
        toolClass: "reasoning",
        risk: "low",
        tags: ["triage", "playbook", "read-only", "incident-response", "mitre"],
        inputSchema: {
          type: "object",
          properties: {
            alertType: {
              type: "string",
              description: "Alert type to retrieve playbook for. Options: brute_force, malware, phishing, data_exfiltration, lateral_movement, privilege_escalation."
            }
          },
          required: ["alertType"],
          additionalProperties: false
        }
      }),
      async (args) => {
        const alertType = requireString(args, "alertType");
        const playbook = getTriagePlaybook(alertType);
        if (playbook) {
          const mitreDetails = playbook.mitreTechniques
            .map((tid) => getMitreTechniqueById(tid))
            .filter(Boolean);
          const result = {
            ...playbook,
            mitreDetails,
            summary: `Triage playbook for ${playbook.title} (${playbook.severity} severity, ${playbook.steps.length} investigation steps).`
          };
          return {
            output: result,
            artifacts: [
              artifact("case_note", `Playbook: ${playbook.alertType}`, result.summary, result)
            ]
          };
        }
        const availableTypes = ["brute_force", "malware", "phishing", "data_exfiltration", "lateral_movement", "privilege_escalation"];
        const notFound = {
          alertType,
          found: false,
          availableTypes,
          summary: `No playbook found for alert type "${alertType}". Available types: ${availableTypes.join(", ")}.`
        };
        return {
          output: notFound,
          artifacts: [
            artifact("case_note", `Playbook: ${alertType}`, notFound.summary, notFound)
          ]
        };
      }
    )
  ];
}

// ============================================================
// Helpers
// ============================================================

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
    deferLoading: false,
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

// ============================================================
// IOC Enrichment (ENHANCED with MITRE, port/ASN/geo heuristics)
// ============================================================

function enrichIndicator(indicator: string) {
  const isDocumentationIp = /^(192\.0\.2|198\.51\.100|203\.0\.113)\./.test(indicator);
  const isPrivateIp = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(indicator);
  const isHashLike = /^[a-f0-9]{32,64}$/i.test(indicator);
  const isDomain = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/i.test(indicator);
  const isUrl = /^https?:\/\//i.test(indicator);
  const isIp = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(indicator);

  const type = isHashLike ? "hash" : isUrl ? "url" : isDomain ? "domain" : "network";

  // Base risk score
  let score = 34;
  if (isHashLike) score = 54;
  else if (isDomain) score = 42;
  else if (isUrl) score = 48;
  else if (isDocumentationIp) score = 5;
  else if (isPrivateIp) score = 10;

  // Threat intelligence lookup
  const intel = lookupThreatIntel(indicator);
  let intelResult = null;
  if (intel) {
    intelResult = {
      category: intel.category,
      severity: intel.severity,
      description: intel.description,
      firstSeen: intel.firstSeen,
      tags: intel.tags,
      mitreTechniques: intel.mitreTechniques
    };
    if (intel.severity === "critical") score = Math.max(score, 95);
    else if (intel.severity === "high") score = Math.max(score, 80);
    else if (intel.severity === "medium") score = Math.max(score, 60);
  }

  // Port heuristics
  let portRisk: { port: number; protocol: string; note: string } | null = null;
  if (isIp) {
    const portMatch = indicator.match(/:(\d+)$/);
    if (portMatch && portMatch[1]) {
      const port = parseInt(portMatch[1], 10);
      const found = suspiciousPortPatterns.find((p) => p.port === port);
      if (found) {
        portRisk = { port: found.port, protocol: found.protocol, note: found.note };
        if (found.risk === "high") score = Math.max(score, 70);
        else if (found.risk === "medium") score = Math.max(score, 50);
      }
    }
  }

  // Geolocation risk hints (sample heuristic)
  let geoRisk = null;
  if (isIp && !isPrivateIp && !isDocumentationIp) {
    geoRisk = geolocationRiskHints[0]; // placeholder; indicates geo context should be checked
  }

  // MITRE ATT&CK mapping from intel
  const mitreTechniques = intel?.mitreTechniques ?? [];
  const mitreDetails = mitreTechniques
    .map((tid) => getMitreTechniqueById(tid))
    .filter(Boolean);

  // Determine confidence
  let confidence = "medium-local";
  if (intel) confidence = "high-intel-match";
  else if (isDocumentationIp) confidence = "low-sample";
  else if (isPrivateIp) confidence = "internal-traffic";

  // Build recommended actions
  const recommendedActions = [
    "Correlate with endpoint and identity telemetry.",
    "Check first-seen and last-seen timestamps.",
    "Escalate only with corroborating evidence."
  ];
  if (intel && intel.severity === "critical") {
    recommendedActions.unshift("URGENT: Known critical threat indicator. Escalate immediately to incident response.");
  }
  if (portRisk) {
    recommendedActions.push(`Note: Port ${portRisk.port}/${portRisk.protocol} is ${portRisk.note}`);
  }

  return {
    indicator,
    type,
    riskScore: score,
    confidence,
    summary: `${indicator} classified as ${type} with risk score ${score}${intel ? ` (matched threat intel: ${intel.category})` : ""}.`,
    recommendedActions,
    threatIntel: intelResult,
    mitreTechniques,
    mitreDetails,
    portRisk,
    geoRiskHint: geoRisk ? "Cross-reference with geolocation context for risk assessment." : null,
    dataSources: ["local heuristics", "sample SecOps knowledge base", "threat intelligence KB", "MITRE ATT&CK mapping"]
  };
}

// ============================================================
// Detection Rules (EXPANDED to 24+ rules)
// ============================================================

const detectionRules = [
  // Initial Access
  {
    name: "Exploit attempt against public-facing web application",
    tactic: "initial-access",
    techniqueId: "T1190",
    dataSources: ["waf_logs", "web_logs", "application_logs"],
    logic: "WAF or application logs show exploit patterns (SQLi, XSS, path traversal, command injection) targeting public-facing services.",
    response: "Validate WAF blocks, review application logs for successful exploitation, and check for webshell deployment."
  },
  {
    name: "VPN authentication from unusual geography",
    tactic: "initial-access",
    techniqueId: "T1133",
    dataSources: ["vpn_logs", "authentication_logs"],
    logic: "Successful VPN authentication from a geography where the organization has no business presence.",
    response: "Verify user identity, check for impossible travel, and review recent account activity for compromise indicators."
  },
  {
    name: "Phishing email with suspicious attachment",
    tactic: "initial-access",
    techniqueId: "T1566",
    dataSources: ["email_gateway", "endpoint_detection"],
    logic: "Email with attachment containing macros, executables, or scripts from external sender with low reputation.",
    response: "Quarantine email, analyze attachment in sandbox, and identify all recipients."
  },
  {
    name: "Suspicious impossible travel login",
    tactic: "initial-access",
    techniqueId: "T1078",
    dataSources: ["identity_provider", "authentication_logs"],
    logic: "Same identity authenticates from distant geographies within a short interval.",
    response: "Validate MFA posture, check for token theft, and review recent password reset activity."
  },

  // Execution
  {
    name: "PowerShell execution with encoded command",
    tactic: "execution",
    techniqueId: "T1059",
    dataSources: ["process_creation", "command_line", "script_block_logging"],
    logic: "PowerShell launched with -EncodedCommand, -enc, or -e flags containing base64 encoded payloads.",
    response: "Decode the command, analyze the script content, and block the associated hash if malicious."
  },
  {
    name: "Office application spawning unusual process",
    tactic: "execution",
    techniqueId: "T1204",
    dataSources: ["process_creation", "office_activity"],
    logic: "Microsoft Office application (Word, Excel, PowerPoint) spawning cmd.exe, powershell.exe, or wscript.exe.",
    response: "Collect the parent document, analyze macros, and quarantine the affected endpoint."
  },
  {
    name: "Endpoint launches unsigned administrative tool",
    tactic: "execution",
    techniqueId: "T1203",
    dataSources: ["edr_process", "file_reputation"],
    logic: "Administrative binary starts from a user-writable path with unknown signature.",
    response: "Collect process tree, signer data, and parent command line. Check for CVE exploitation."
  },
  {
    name: "Scheduled task creation from unusual process",
    tactic: "execution",
    techniqueId: "T1053",
    dataSources: ["scheduled_task_logs", "process_creation"],
    logic: "New scheduled task created by a non-system process, especially from temporary or user directories.",
    response: "Review the task action, trigger, and associated binary. Check for persistence intent."
  },

  // Persistence
  {
    name: "Registry Run key modification",
    tactic: "persistence",
    techniqueId: "T1547",
    dataSources: ["registry", "process_creation"],
    logic: "New or modified registry entries in Run, RunOnce, or similar autostart locations.",
    response: "Verify the binary path, check digital signature, and review the creating process."
  },
  {
    name: "New Windows service creation",
    tactic: "persistence",
    techniqueId: "T1543",
    dataSources: ["service_creation", "process_creation", "windows_event_logs"],
    logic: "New Windows service created with binary path pointing to unusual or user-writable locations.",
    response: "Validate service binary, check for known malicious paths, and review service account permissions."
  },

  // Privilege Escalation
  {
    name: "Privilege change outside maintenance window",
    tactic: "privilege-escalation",
    techniqueId: "T1068",
    dataSources: ["iam", "audit_log"],
    logic: "Role membership changes outside the approved change window.",
    response: "Confirm ticket linkage and review actor session history."
  },
  {
    name: "Process injection detected via API monitoring",
    tactic: "privilege-escalation",
    techniqueId: "T1055",
    dataSources: ["api_monitoring", "endpoint_detection", "process_creation"],
    logic: "Detection of VirtualAllocEx, WriteProcessMemory, or CreateRemoteThread API calls targeting sensitive processes.",
    response: "Isolate the source process, collect memory dumps, and check for injected code."
  },
  {
    name: "UAC bypass attempt detected",
    tactic: "privilege-escalation",
    techniqueId: "T1548",
    dataSources: ["process_creation", "windows_event_logs"],
    logic: "Process attempts to bypass UAC via fodhelper, eventvwr, or other known bypass techniques.",
    response: "Block the process, review parent process chain, and check for additional compromise."
  },

  // Defense Evasion
  {
    name: "Security event log cleared",
    tactic: "defense-evasion",
    techniqueId: "T1070",
    dataSources: ["windows_event_logs", "audit_logs"],
    logic: "Windows Security event log cleared using wevtutil or EventLog API, indicated by Event ID 1102.",
    response: "Preserve any remaining logs from other sources, investigate the clearing account, and check for concurrent attacks."
  },
  {
    name: "Antivirus or EDR service stopped",
    tactic: "defense-evasion",
    techniqueId: "T1562",
    dataSources: ["service_monitoring", "process_creation"],
    logic: "Security service (AV, EDR, firewall) stopped or disabled unexpectedly.",
    response: "Restart the service immediately, investigate the stopping process, and check for malware."
  },
  {
    name: "Base64-encoded PowerShell download cradle",
    tactic: "defense-evasion",
    techniqueId: "T1027",
    dataSources: ["process_creation", "script_block_logging", "command_line"],
    logic: "Encoded PowerShell command containing Invoke-WebRequest, Net.WebClient, or IEX download patterns.",
    response: "Decode and analyze the payload, block the download URL, and quarantine the endpoint."
  },

  // Credential Access
  {
    name: "LSASS process memory access",
    tactic: "credential-access",
    techniqueId: "T1003",
    dataSources: ["process_creation", "api_monitoring", "sysmon"],
    logic: "Process attempts to access LSASS.exe memory space, typically via procdump, mimikatz, or task manager dump.",
    response: "Block the process, enable LSA protection, and rotate credentials for accounts active on the host."
  },
  {
    name: "Unsecured credentials in script or configuration file",
    tactic: "credential-access",
    techniqueId: "T1552",
    dataSources: ["file_monitoring", "command_line"],
    logic: "Sensitive credential patterns (passwords, API keys, tokens) found in scripts, config files, or command history.",
    response: "Remove the credentials, rotate them immediately, and implement secret management solution."
  },
  {
    name: "Multiple failed authentication attempts",
    tactic: "credential-access",
    techniqueId: "T1110",
    dataSources: ["authentication_logs", "vpn_logs", "windows_event_logs"],
    logic: "High volume of failed logins (Event ID 4625) from a single source IP across multiple accounts.",
    response: "Block the source IP, check for successful logins, and enforce MFA for affected accounts."
  },

  // Discovery
  {
    name: "System information enumeration commands",
    tactic: "discovery",
    techniqueId: "T1082",
    dataSources: ["process_creation", "command_line"],
    logic: "Execution of systeminfo, hostname, whoami, net config, or similar system enumeration commands from non-admin context.",
    response: "Correlate with other discovery activity and check for subsequent lateral movement."
  },
  {
    name: "Internal port scanning activity",
    tactic: "discovery",
    techniqueId: "T1046",
    dataSources: ["network_traffic", "firewall_logs"],
    logic: "Internal host scanning multiple ports across different internal IPs in a short timeframe.",
    response: "Identify the scanning host, check for compromise, and isolate if unauthorized."
  },
  {
    name: "Recursive file system enumeration",
    tactic: "discovery",
    techniqueId: "T1083",
    dataSources: ["process_creation", "command_line", "file_access_logs"],
    logic: "Recursive directory listing (dir /s, ls -R, tree, Get-ChildItem -Recurse) from unusual processes.",
    response: "Check what directories were enumerated and whether sensitive data locations were targeted."
  },

  // Lateral Movement
  {
    name: "SMB/Admin share access from workstation to server",
    tactic: "lateral-movement",
    techniqueId: "T1021",
    dataSources: ["network_traffic", "authentication_logs", "file_monitoring"],
    logic: "Workstation accessing C$ or ADMIN$ shares on servers, especially from non-IT user accounts.",
    response: "Verify the access legitimacy, check for tool transfer, and review the source host for compromise."
  },
  {
    name: "Pass-the-Hash authentication detected",
    tactic: "lateral-movement",
    techniqueId: "T1550",
    dataSources: ["authentication_logs", "windows_event_logs"],
    logic: "NTLM authentication using Event ID 4624 with LogonType 3 and NTLMv1, or anomalous NTLM usage patterns.",
    response: "Investigate source host, rotate affected credentials, and enable Credential Guard."
  },

  // Command and Control
  {
    name: "High-volume outbound DNS to new domain",
    tactic: "command-and-control",
    techniqueId: "T1071",
    dataSources: ["dns_logs", "proxy_logs"],
    logic: "Host produces repeated DNS lookups for a domain first seen in the last 24 hours.",
    response: "Compare against business owner, check for DNS tunneling indicators, and isolate if unconfirmed."
  },
  {
    name: "Beaconing traffic pattern detected",
    tactic: "command-and-control",
    techniqueId: "T1573",
    dataSources: ["network_traffic", "proxy_logs", "netflow"],
    logic: "Regular outbound connections at consistent intervals (e.g., every 60s, 300s) indicative of C2 beaconing.",
    response: "Block the destination, analyze the beacon protocol, and investigate the source host for compromise."
  },
  {
    name: "Download of executable from newly registered domain",
    tactic: "command-and-control",
    techniqueId: "T1105",
    dataSources: ["proxy_logs", "dns_logs", "file_monitoring"],
    logic: "Download of PE executables or scripts from domains registered within the last 30 days.",
    response: "Analyze the downloaded file, block the domain, and check for execution on the endpoint."
  },

  // Exfiltration
  {
    name: "Large outbound data transfer to external IP",
    tactic: "exfiltration",
    techniqueId: "T1048",
    dataSources: ["network_traffic", "netflow", "proxy_logs"],
    logic: "Outbound data transfer exceeding 100MB to an external IP not associated with known business services.",
    response: "Investigate the data source, block the destination, and initiate data loss prevention procedures."
  },
  {
    name: "Data upload to cloud storage service",
    tactic: "exfiltration",
    techniqueId: "T1567",
    dataSources: ["proxy_logs", "dns_logs", "network_traffic"],
    logic: "Large upload to cloud storage (Dropbox, Google Drive, Mega, etc.) from a non-standard application.",
    response: "Check the uploaded content, verify user authorization, and block the service if unauthorized."
  },

  // Impact
  {
    name: "Mass file extension modification",
    tactic: "impact",
    techniqueId: "T1486",
    dataSources: ["file_monitoring", "file_system_logs"],
    logic: "Rapid modification of file extensions across multiple directories, characteristic of ransomware encryption.",
    response: "IMMEDIATE: Isolate the affected host, block SMB shares, and initiate incident response."
  },
  {
    name: "Volume shadow copy deletion",
    tactic: "impact",
    techniqueId: "T1490",
    dataSources: ["process_creation", "command_line", "windows_event_logs"],
    logic: "Execution of vssadmin delete shadows or wmic shadowcopy delete commands.",
    response: "IMMEDIATE: Isolate the host, preserve any remaining backups, and check for ransomware indicators."
  },
  {
    name: "Disk wiping tool execution",
    tactic: "impact",
    techniqueId: "T1485",
    dataSources: ["process_creation", "file_monitoring"],
    logic: "Execution of disk wiping utilities (sdelete, diskpart clean, dd) or MBR modification tools.",
    response: "IMMEDIATE: Isolate the host, preserve disk images, and initiate incident response procedures."
  }
];

function searchRules(query: string, tactic?: string) {
  const terms = `${query} ${tactic ?? ""}`.toLowerCase().split(/\W+/).filter(Boolean);
  return detectionRules
    .map((rule) => ({
      ...rule,
      score: terms.filter(
        (term) =>
          rule.name.toLowerCase().includes(term) ||
          rule.tactic.toLowerCase().includes(term) ||
          (rule.techniqueId && rule.techniqueId.toLowerCase().includes(term)) ||
          rule.dataSources.some((ds) => ds.toLowerCase().includes(term)) ||
          rule.logic.toLowerCase().includes(term) ||
          rule.response.toLowerCase().includes(term)
      ).length
    }))
    .filter((rule) => rule.score > 0 || !terms.length)
    .sort((left, right) => right.score - left.score)
    .slice(0, 5);
}

// ============================================================
// Asset Inventory (EXPANDED to 17 assets with network segments)
// ============================================================

const sampleAssets = [
  {
    aliases: ["workstation-042", "198.51.100.23"],
    hostname: "FIN-WS-042",
    ip: "192.168.10.23",
    owner: "Finance Operations",
    department: "Finance",
    criticality: "medium",
    networkSegment: "FINANCE_VLAN_10",
    subnet: "192.168.10.0/24",
    summary: "Finance workstation with normal business-hour activity profile. Access to ERP and payroll systems.",
    containmentNote: "Human approval required before isolation during payroll windows.",
    businessContext: "Used by accounts payable team. Contains sensitive financial data subject to SOX compliance."
  },
  {
    aliases: ["idp-prod-01", "auth"],
    hostname: "IDP-PROD-01",
    ip: "192.168.50.10",
    owner: "Identity Platform",
    department: "IT",
    criticality: "high",
    networkSegment: "IDENTITY_DMZ_50",
    subnet: "192.168.50.0/24",
    summary: "Production identity provider node (Azure AD Connect / Okta agent).",
    containmentNote: "No automated containment; escalate to identity on-call.",
    businessContext: "Core authentication infrastructure. Outage affects all user logins across the organization."
  },
  {
    aliases: ["db-prod-01", "192.168.30.15"],
    hostname: "DB-PROD-01",
    ip: "192.168.30.15",
    owner: "Database Administration",
    department: "Engineering",
    criticality: "critical",
    networkSegment: "DATABASE_VLAN_30",
    subnet: "192.168.30.0/24",
    summary: "Primary production PostgreSQL database server hosting customer and transaction data.",
    containmentNote: "Never isolate without DBA and CTO approval. Snapshots must be taken before any action.",
    businessContext: "Core database for customer-facing applications. Contains PII and payment data (PCI scope)."
  },
  {
    aliases: ["hr-portal-01", "192.168.15.20"],
    hostname: "HR-PORTAL-01",
    ip: "192.168.15.20",
    owner: "HR Operations",
    department: "HR",
    criticality: "high",
    networkSegment: "HR_VLAN_15",
    subnet: "192.168.15.0/24",
    summary: "HR information system hosting employee records, payroll data, and performance reviews.",
    containmentNote: "Requires HR Director approval for isolation. Contains PII subject to GDPR/CCPA.",
    businessContext: "Central repository for all employee data. Includes sensitive personal and compensation information."
  },
  {
    aliases: ["legal-dms-01", "192.168.20.10"],
    hostname: "LEGAL-DMS-01",
    ip: "192.168.20.10",
    owner: "Legal Department",
    department: "Legal",
    criticality: "high",
    networkSegment: "LEGAL_VLAN_20",
    subnet: "192.168.20.0/24",
    summary: "Document management system for legal contracts, regulatory filings, and intellectual property.",
    containmentNote: "Legal hold may prevent isolation. Consult General Counsel before any action.",
    businessContext: "Contains privileged legal documents, M&A data, and patent filings. Attorney-client privilege applies."
  },
  {
    aliases: ["mktg-cms-01", "192.168.25.10"],
    hostname: "MKTG-CMS-01",
    ip: "192.168.25.10",
    owner: "Marketing Operations",
    department: "Marketing",
    criticality: "medium",
    networkSegment: "MARKETING_VLAN_25",
    subnet: "192.168.25.0/24",
    summary: "Content management system for public-facing website and marketing campaigns.",
    containmentNote: "Can be isolated during non-business hours. Coordinate with Marketing Director.",
    businessContext: "Hosts public website content. Defacement would cause reputational damage."
  },
  {
    aliases: ["sales-crm-01", "192.168.35.10"],
    hostname: "SALES-CRM-01",
    ip: "192.168.35.10",
    owner: "Sales Operations",
    department: "Sales",
    criticality: "high",
    networkSegment: "SALES_VLAN_35",
    subnet: "192.168.35.0/24",
    summary: "CRM system hosting customer relationships, pipeline data, and sales contracts.",
    containmentNote: "Isolation impacts all sales operations. Coordinate with VP Sales.",
    businessContext: "Contains customer contact data, deal pipeline, and revenue forecasts. Critical for business operations."
  },
  {
    aliases: ["ops-scada-01", "192.168.40.10"],
    hostname: "OPS-SCADA-01",
    ip: "192.168.40.10",
    owner: "Operations",
    department: "Operations",
    criticality: "critical",
    networkSegment: "OT_SCADA_40",
    subnet: "192.168.40.0/24",
    summary: "SCADA monitoring system for manufacturing/industrial control systems.",
    containmentNote: "NEVER isolate without OT engineering approval. Safety-critical systems.",
    businessContext: "Industrial control systems. Disruption could cause physical safety incidents and production shutdown."
  },
  {
    aliases: ["rd-jupyter-01", "192.168.45.10"],
    hostname: "RD-JUPYTER-01",
    ip: "192.168.45.10",
    owner: "Research & Development",
    department: "R&D",
    criticality: "high",
    networkSegment: "RD_VLAN_45",
    subnet: "192.168.45.0/24",
    summary: "JupyterHub server for data science and machine learning research.",
    containmentNote: "May contain proprietary algorithms. Coordinate with R&D Director before action.",
    businessContext: "Intellectual property development. Contains proprietary ML models, research data, and trade secrets."
  },
  {
    aliases: ["exec-boardroom-01", "192.168.5.10"],
    hostname: "EXEC-BOARDROOM-01",
    ip: "192.168.5.10",
    owner: "Executive Office",
    department: "Executive",
    criticality: "high",
    networkSegment: "EXECUTIVE_VLAN_5",
    subnet: "192.168.5.0/24",
    summary: "Executive boardroom system with video conferencing and presentation capabilities.",
    containmentNote: "Escalate to CISO and Chief of Staff before any action on executive systems.",
    businessContext: "Used for board meetings, earnings calls, and strategic discussions. May contain MNPI."
  },
  {
    aliases: ["sec-siem-01", "192.168.99.10"],
    hostname: "SEC-SIEM-01",
    ip: "192.168.99.10",
    owner: "Security Operations",
    department: "Security",
    criticality: "critical",
    networkSegment: "SECURITY_VLAN_99",
    subnet: "192.168.99.0/24",
    summary: "SIEM collector and correlation engine for security event monitoring.",
    containmentNote: "Never isolate. This is the security monitoring backbone. Tampering would blind SOC.",
    businessContext: "Central security monitoring. Compromise would allow attackers to blind security operations."
  },
  {
    aliases: ["eng-gitlab-01", "192.168.70.10"],
    hostname: "ENG-GITLAB-01",
    ip: "192.168.70.10",
    owner: "Engineering Platform",
    department: "Engineering",
    criticality: "high",
    networkSegment: "ENGINEERING_VLAN_70",
    subnet: "192.168.70.0/24",
    summary: "GitLab source code repository hosting all application source code.",
    containmentNote: "Coordinate with VP Engineering. Source code is critical IP.",
    businessContext: "Contains all source code, CI/CD pipelines, and deployment secrets. Compromise enables supply chain attacks."
  },
  {
    aliases: ["it-jump-01", "192.168.100.10"],
    hostname: "IT-JUMP-01",
    ip: "192.168.100.10",
    owner: "IT Infrastructure",
    department: "IT",
    criticality: "critical",
    networkSegment: "MGMT_VLAN_100",
    subnet: "192.168.100.0/24",
    summary: "Jump host / bastion server for IT administrative access to production infrastructure.",
    containmentNote: "Compromise of this host indicates full infrastructure compromise. Activate incident response.",
    businessContext: "Administrative gateway to all production systems. Keys to the kingdom."
  },
  {
    aliases: ["fin-erp-01", "192.168.10.50"],
    hostname: "FIN-ERP-01",
    ip: "192.168.10.50",
    owner: "Finance Systems",
    department: "Finance",
    criticality: "critical",
    networkSegment: "FINANCE_VLAN_10",
    subnet: "192.168.10.0/24",
    summary: "ERP system (SAP/Oracle) hosting financial transactions, general ledger, and procurement.",
    containmentNote: "Isolation blocks all financial operations. CFO approval required.",
    businessContext: "Core financial system. Disruption impacts accounts payable, receivable, and financial reporting."
  },
  {
    aliases: ["mktg-mailchimp-01", "192.168.25.30"],
    hostname: "MKTG-MAILCHIMP-01",
    ip: "192.168.25.30",
    owner: "Marketing Automation",
    department: "Marketing",
    criticality: "medium",
    networkSegment: "MARKETING_VLAN_25",
    subnet: "192.168.25.0/24",
    summary: "Email marketing automation platform connector for customer communications.",
    containmentNote: "Can be isolated with notice. Impacts customer email communications.",
    businessContext: "Sends marketing emails to customer base. Compromise could lead to phishing attacks against customers."
  },
  {
    aliases: ["legal-ediscovery-01", "192.168.20.30"],
    hostname: "LEGAL-EDISCOVERY-01",
    ip: "192.168.20.30",
    owner: "Legal Operations",
    department: "Legal",
    criticality: "high",
    networkSegment: "LEGAL_VLAN_20",
    subnet: "192.168.20.0/24",
    summary: "eDiscovery platform for litigation holds, legal document review, and regulatory compliance.",
    containmentNote: "Legal hold may apply. Consult General Counsel. Data integrity is paramount.",
    businessContext: "Contains litigation data, regulatory investigation materials, and compliance evidence."
  },
  {
    aliases: ["hr-recruiting-01", "192.168.15.40"],
    hostname: "HR-RECRUITING-01",
    ip: "192.168.15.40",
    owner: "Talent Acquisition",
    department: "HR",
    criticality: "medium",
    networkSegment: "HR_VLAN_15",
    subnet: "192.168.15.0/24",
    summary: "Applicant tracking system (ATS) for recruiting, candidate management, and onboarding.",
    containmentNote: "Can be isolated with HR notice. Contains candidate PII.",
    businessContext: "Contains candidate resumes, interview feedback, and offer letters. PII subject to privacy regulations."
  }
];

function lookupAsset(asset: string) {
  const normalized = asset.toLowerCase();
  const match = sampleAssets.find((item) =>
    item.aliases.some((alias) => alias.toLowerCase() === normalized) ||
    item.hostname.toLowerCase() === normalized ||
    item.ip === normalized
  );
  if (match) {
    return {
      asset,
      found: true,
      hostname: match.hostname,
      ip: match.ip,
      owner: match.owner,
      department: match.department,
      criticality: match.criticality,
      networkSegment: match.networkSegment,
      subnet: match.subnet,
      businessContext: match.businessContext,
      summary: match.summary,
      containmentNote: match.containmentNote
    };
  }
  return {
    asset,
    found: false,
    hostname: null,
    ip: null,
    owner: "unknown",
    department: "unknown",
    criticality: "unknown",
    networkSegment: "unknown",
    subnet: "unknown",
    businessContext: "Not found in sample asset inventory.",
    summary: "No matching sample asset found.",
    containmentNote: "Do not take automated action without ownership confirmation."
  };
}
