import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamResult
} from "@ai-sdk/provider";
import type { LanguageModel } from "ai";

export function createScriptedModel(latestUserText: string): LanguageModel {
  return new ScriptedLanguageModel(latestUserText);
}

class ScriptedLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3";
  readonly provider = "test-provider";
  readonly modelId = "test-model";
  readonly supportedUrls = {};
  private step = 0;

  constructor(private readonly latestUserText: string) {}

  async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    this.step += 1;
    if (this.step === 1) {
      const toolName = chooseTool(this.latestUserText.toLowerCase(), options.tools?.map((tool) => tool.name) ?? []);
      if (toolName) {
        return {
          content: [
            {
              type: "tool-call",
              toolCallId: `call_${crypto.randomUUID()}`,
              toolName,
              input: JSON.stringify(buildArguments(toolName, this.latestUserText))
            }
          ],
          finishReason: { unified: "tool-calls", raw: "tool_calls" },
          usage: usage(120, 24),
          warnings: []
        };
      }
    }

    return {
      content: [
        {
          type: "text",
          text:
            "I reviewed the available tool evidence. Preserve the artifact trail, validate ownership, and only escalate to side-effecting action when the permission level allows it."
        }
      ],
      finishReason: { unified: "stop", raw: "stop" },
      usage: usage(140, 34),
      warnings: []
    };
  }

  async doStream(_options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    throw new Error("Streaming is not implemented for the scripted test model.");
  }
}

function chooseTool(userText: string, toolNames: string[]): string | undefined {
  const preference = userText.includes("wazuh") && (userText.includes("block") || userText.includes("阻断"))
    ? "secops_wazuh_block_ip"
    : userText.includes("wazuh") && (userText.includes("config") || userText.includes("status") || userText.includes("配置"))
      ? "secops_wazuh_config_status"
    : userText.includes("wazuh") && (userText.includes("alert") || userText.includes("告警"))
      ? "secops_wazuh_alerts_search"
    : userText.includes("wazuh") && (userText.includes("network") || userText.includes("网络") || userText.includes("内网"))
      ? "secops_wazuh_agent_network_summary"
    : userText.includes("wazuh") && (userText.includes("port") || userText.includes("端口"))
      ? "secops_wazuh_agent_ports_list"
      : userText.includes("wazuh") && userText.includes("agent")
        ? "secops_wazuh_agents_list"
        : userText.includes("write note") || userText.includes("case note")
    ? "secops_case_note_write"
    : userText.includes("run command") || userText.includes("git status")
      ? "secops_command_run_sandbox"
      : userText.includes("ioc") || /\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(userText) || /[a-f0-9]{32,64}/i.test(userText)
        ? "secops_ioc_enrich"
        : userText.includes("asset") || userText.includes("host")
          ? "secops_asset_inventory_lookup"
          : userText.includes("sigma") || userText.includes("rule") || userText.includes("detect")
            ? "secops_detection_rule_search"
            : userText.includes("evidence") || userText.includes("case")
              ? "secops_case_evidence_pack"
              : "secops_ioc_enrich";

  return toolNames.includes(preference) ? preference : toolNames[0];
}

function buildArguments(toolName: string, userText: string): Record<string, unknown> {
  if (toolName === "secops_wazuh_agent_ports_list") {
    return {
      agentId: "001",
      limit: 25,
      query: "state=LISTEN"
    };
  }
  if (toolName === "secops_wazuh_config_status") {
    return {};
  }
  if (toolName === "secops_wazuh_agent_network_summary") {
    return {
      agentId: "001",
      portLimit: 25,
      processLimit: 25,
      portQuery: "state=LISTEN"
    };
  }
  if (toolName === "secops_wazuh_agents_list") {
    return {
      status: "active",
      limit: 10
    };
  }
  if (toolName === "secops_wazuh_block_ip") {
    return {
      ip: "203.0.113.10",
      agentIds: ["001"],
      command: "firewall-drop",
      durationSeconds: 3600,
      reason: userText || "Scripted Wazuh block request"
    };
  }
  if (toolName === "secops_wazuh_alerts_search") {
    return {
      sourceIp: "203.0.113.10",
      agentId: "001",
      timeWindowMinutes: 60,
      limit: 5
    };
  }
  if (toolName === "secops_case_note_write") {
    return {
      caseId: "INC-LOCAL-TEST",
      title: "Automated test note",
      body: `Analyst request: ${userText || "local test"}. Tool write stayed inside sandbox.`
    };
  }
  if (toolName === "secops_command_run_sandbox") {
    return { commandId: userText.toLowerCase().includes("git") ? "git_status" : "node_version" };
  }
  if (toolName === "secops_detection_rule_search") {
    return { query: userText || "suspicious authentication", tactic: "credential-access" };
  }
  if (toolName === "secops_asset_inventory_lookup") {
    return { asset: extractToken(userText) || "workstation-042" };
  }
  if (toolName === "secops_case_evidence_pack") {
    return {
      caseTitle: "Suspicious activity triage",
      observations: [userText || "Analyst requested bounded evidence collection"]
    };
  }
  return { indicator: extractToken(userText) || "198.51.100.23" };
}

function extractToken(text: string): string | undefined {
  return text.split(/\s+/).find((token) => token.includes(".") || token.includes("-"));
}

function usage(input: number, output: number) {
  return {
    inputTokens: {
      total: input,
      noCache: input,
      cacheRead: undefined,
      cacheWrite: undefined
    },
    outputTokens: {
      total: output,
      text: output,
      reasoning: undefined
    }
  };
}
