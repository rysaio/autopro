import { shuffleConfigStatus } from "../core/configStatus.js";
import { ShuffleClient, validatedUrl } from "../core/shuffleClient.js";
import type { ModelTool, ShuffleExecutionContext, ShuffleExecutionResult, ShufflePluginTool, SkillManifest, ToolClass, ToolRisk } from "./types.js";
import { artifact, boundedInteger, optionalString, parseJsonObject, pickSummary, requireString, responseItems } from "./helpers.js";

type ToolHandler = (args: Record<string, unknown>, context: ShuffleExecutionContext) => Promise<ShuffleExecutionResult>;

class ShuffleTool implements ShufflePluginTool {
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

  execute(args: Record<string, unknown>, context: ShuffleExecutionContext): Promise<ShuffleExecutionResult> {
    return this.handler(args, context);
  }
}

export function createShuffleTools(clientFactory: () => ShuffleClient = memoizedShuffleClient()): ShufflePluginTool[] {
  return [
    new ShuffleTool(
      "secops_shuffle_config_status",
      manifest({
        id: "shuffle.config.status",
        name: "Shuffle Configuration Status",
        description: "Report sanitized Shuffle API readiness without exposing API keys.",
        toolClass: "perception",
        risk: "low",
        tags: ["shuffle", "configuration", "readiness", "read-only"],
        inputSchema: emptySchema()
      }),
      async () => {
        const output = shuffleConfigStatus(process.env);
        return {
          output,
          artifacts: [artifact("Shuffle configuration status", "Sanitized Shuffle configuration readiness checked.", output)]
        };
      }
    ),
    new ShuffleTool(
      "secops_shuffle_health",
      manifest({
        id: "shuffle.health",
        name: "Shuffle Health",
        description: "Verify Shuffle API connectivity and authentication with a bounded workflow listing request.",
        toolClass: "perception",
        risk: "low",
        tags: ["shuffle", "health", "read-only"],
        inputSchema: emptySchema()
      }),
      async () => {
        const client = clientFactory();
        const raw = await client.health();
        const output = {
          apiReachable: true,
          endpointHost: client.endpointHost(),
          sampleCount: responseItems(raw).length,
          raw
        };
        return {
          output,
          artifacts: [artifact("Shuffle health", "Shuffle API authentication and connectivity verified.", output)]
        };
      }
    ),
    new ShuffleTool(
      "secops_shuffle_workflows_list",
      manifest({
        id: "shuffle.workflows.list",
        name: "List Shuffle Workflows",
        description: "List Shuffle workflows for analyst scoping with optional limit and query filters.",
        toolClass: "perception",
        risk: "low",
        tags: ["shuffle", "workflows", "read-only"],
        inputSchema: {
          type: "object",
          properties: {
            limit: { type: "number", description: "Maximum workflows to request, from 1 to 500." },
            query: { type: "string", description: "Optional Shuffle workflow query/search value." }
          },
          required: [],
          additionalProperties: false
        }
      }),
      async (args) => {
        const query = workflowListQuery(args);
        const raw = await clientFactory().listWorkflows(query);
        const workflows = responseItems(raw).map((item) => pickSummary(item, ["id", "name", "description", "status", "last_runtime", "created", "updated"]));
        const output = {
          endpointClass: "shuffle.workflows",
          count: workflows.length,
          filters: query,
          workflows,
          raw
        };
        return {
          output,
          artifacts: [artifact("Shuffle workflows", `${workflows.length} Shuffle workflow(s) returned.`, output)]
        };
      }
    ),
    new ShuffleTool(
      "secops_shuffle_workflow_get",
      manifest({
        id: "shuffle.workflow.get",
        name: "Get Shuffle Workflow",
        description: "Inspect one Shuffle workflow definition by id.",
        toolClass: "perception",
        risk: "low",
        tags: ["shuffle", "workflow", "read-only"],
        inputSchema: {
          type: "object",
          properties: {
            workflowId: { type: "string", description: "Shuffle workflow id." }
          },
          required: ["workflowId"],
          additionalProperties: false
        }
      }),
      async (args) => {
        const workflowId = requireString(args, "workflowId");
        const raw = await clientFactory().getWorkflow(workflowId);
        const output = {
          endpointClass: "shuffle.workflow",
          workflowId,
          workflow: pickSummary(raw, ["id", "name", "description", "status", "triggers", "actions"]),
          raw
        };
        return {
          output,
          artifacts: [artifact(`Shuffle workflow: ${workflowId}`, `Shuffle workflow ${workflowId} inspected.`, output)]
        };
      }
    ),
    new ShuffleTool(
      "secops_shuffle_workflow_execute",
      manifest({
        id: "shuffle.workflow.execute",
        name: "Execute Shuffle Workflow",
        description: "Execute one explicit Shuffle workflow with a JSON object argument. This can trigger SOAR side effects.",
        toolClass: "action",
        risk: "high",
        tags: ["shuffle", "workflow", "execute", "action"],
        inputSchema: {
          type: "object",
          properties: {
            workflowId: { type: "string", description: "Shuffle workflow id." },
            executionArgumentJson: { type: "string", description: "Optional JSON object sent as the workflow execution argument." },
            reason: { type: "string", description: "Required analyst/audit reason for executing the workflow." }
          },
          required: ["workflowId", "reason"],
          additionalProperties: false
        }
      }),
      async (args, context) => {
        const workflowId = requireString(args, "workflowId");
        const reason = requireString(args, "reason");
        const executionArgument = parseJsonObject(optionalString(args, "executionArgumentJson"), "executionArgumentJson");
        const raw = await clientFactory().executeWorkflow(workflowId, executionArgument);
        const output = {
          policyDecision: `executed under ${context.actionLevel} access level`,
          endpointClass: "shuffle.workflow.execute",
          workflowId,
          reason,
          executionArgument,
          raw
        };
        return {
          output,
          artifacts: [artifact(`Shuffle workflow execution: ${workflowId}`, `Requested Shuffle workflow execution for ${workflowId}.`, output)]
        };
      }
    ),
    new ShuffleTool(
      "secops_shuffle_workflow_executions_list",
      manifest({
        id: "shuffle.workflow.executions.list",
        name: "List Shuffle Workflow Executions",
        description: "List recent executions for one Shuffle workflow.",
        toolClass: "perception",
        risk: "low",
        tags: ["shuffle", "workflow", "executions", "read-only"],
        inputSchema: {
          type: "object",
          properties: {
            workflowId: { type: "string", description: "Shuffle workflow id." },
            limit: { type: "number", description: "Maximum executions to request, from 1 to 500." }
          },
          required: ["workflowId"],
          additionalProperties: false
        }
      }),
      async (args) => {
        const workflowId = requireString(args, "workflowId");
        const query = { limit: boundedInteger(args, "limit", 25, 1, 500) };
        const raw = await clientFactory().listWorkflowExecutions(workflowId, query);
        const executions = responseItems(raw).map((item) => pickSummary(item, ["execution_id", "id", "status", "started_at", "completed_at", "workflow_id"]));
        const output = {
          endpointClass: "shuffle.workflow.executions",
          workflowId,
          count: executions.length,
          filters: query,
          executions,
          raw
        };
        return {
          output,
          artifacts: [artifact("Shuffle workflow executions", `${executions.length} execution(s) returned for workflow ${workflowId}.`, output)]
        };
      }
    ),
    new ShuffleTool(
      "secops_shuffle_execution_result_get",
      manifest({
        id: "shuffle.execution.result.get",
        name: "Get Shuffle Execution Result",
        description: "Fetch a Shuffle execution result through the streams/results endpoint.",
        toolClass: "perception",
        risk: "low",
        tags: ["shuffle", "execution", "result", "read-only"],
        inputSchema: {
          type: "object",
          properties: {
            executionId: { type: "string", description: "Shuffle execution id." },
            authorization: { type: "string", description: "Optional Shuffle execution authorization value when required by the server." }
          },
          required: ["executionId"],
          additionalProperties: false
        }
      }),
      async (args) => {
        const executionId = requireString(args, "executionId");
        const raw = await clientFactory().getExecutionResult(executionId, optionalString(args, "authorization"));
        const output = {
          endpointClass: "shuffle.execution.result",
          executionId,
          raw
        };
        return {
          output,
          artifacts: [artifact(`Shuffle execution result: ${executionId}`, `Fetched Shuffle execution result ${executionId}.`, output)]
        };
      }
    ),
    new ShuffleTool(
      "secops_shuffle_apps_list",
      manifest({
        id: "shuffle.apps.list",
        name: "List Shuffle Apps",
        description: "List Shuffle apps for workflow capability discovery.",
        toolClass: "perception",
        risk: "low",
        tags: ["shuffle", "apps", "read-only"],
        inputSchema: {
          type: "object",
          properties: {
            limit: { type: "number", description: "Maximum apps to request, from 1 to 500." },
            query: { type: "string", description: "Optional app query/search value." }
          },
          required: [],
          additionalProperties: false
        }
      }),
      async (args) => {
        const query = workflowListQuery(args);
        const raw = await clientFactory().listApps(query);
        const apps = responseItems(raw).map((item) => pickSummary(item, ["id", "name", "description", "app_version", "categories"]));
        const output = {
          endpointClass: "shuffle.apps",
          count: apps.length,
          filters: query,
          apps,
          raw
        };
        return {
          output,
          artifacts: [artifact("Shuffle apps", `${apps.length} Shuffle app(s) returned.`, output)]
        };
      }
    ),
    new ShuffleTool(
      "secops_shuffle_wazuh_integration_render",
      manifest({
        id: "shuffle.wazuh.integration.render",
        name: "Render Wazuh Shuffle Integration",
        description: "Render a Wazuh Integrator XML snippet for forwarding JSON alerts to an explicit Shuffle webhook URL.",
        toolClass: "evidence",
        risk: "low",
        tags: ["shuffle", "wazuh", "integration", "webhook", "read-only"],
        inputSchema: {
          type: "object",
          properties: {
            webhookUrl: { type: "string", description: "Explicit Shuffle webhook URL copied from the Shuffle trigger." },
            level: { type: "number", description: "Optional minimum Wazuh alert level." },
            ruleId: { type: "string", description: "Optional Wazuh rule_id filter." },
            group: { type: "string", description: "Optional Wazuh group filter." },
            eventLocation: { type: "string", description: "Optional Wazuh event_location filter." }
          },
          required: ["webhookUrl"],
          additionalProperties: false
        }
      }),
      async (args) => {
        const input = wazuhIntegrationInput(args);
        const xml = renderWazuhIntegrationXml(input);
        const output = {
          endpointClass: "shuffle.wazuh.integration",
          webhookHost: new URL(input.webhookUrl).host,
          alertFormat: "json",
          filters: {
            level: input.level,
            ruleId: input.ruleId,
            group: input.group,
            eventLocation: input.eventLocation
          },
          xml,
          notes: [
            "Add this inside Wazuh manager ossec.conf and restart Wazuh manager.",
            "Use the exact webhook URL copied from Shuffle because URL shapes vary by Shuffle version.",
            "This tool renders configuration only; it does not edit Wazuh files."
          ]
        };
        return {
          output,
          artifacts: [artifact("Wazuh Shuffle integration XML", "Rendered Wazuh Integrator XML for Shuffle webhook forwarding.", output)]
        };
      }
    ),
    webhookTool("secops_shuffle_webhook_trigger", "shuffle.webhook.trigger", "Trigger Shuffle Webhook", "Trigger an explicit Shuffle webhook URL with optional JSON payload and headers."),
    webhookTool("secops_shuffle_wazuh_alert_forward", "shuffle.wazuh.alert.forward", "Forward Wazuh Alert To Shuffle", "Forward one Wazuh alert JSON object to an explicit Shuffle webhook URL."),
    new ShuffleTool(
      "secops_shuffle_mcp_call",
      manifest({
        id: "shuffle.mcp.call",
        name: "Call Shuffle Built-In MCP",
        description: "Call Shuffle's built-in HTTP MCP endpoint with a JSON-RPC-style method and optional params. This may call SOAR tools.",
        toolClass: "action",
        risk: "high",
        tags: ["shuffle", "mcp", "agent", "action"],
        inputSchema: {
          type: "object",
          properties: {
            method: { type: "string", description: "Shuffle MCP method, for example ping, tools/list, or tools/call." },
            paramsJson: { type: "string", description: "Optional JSON object params for the Shuffle MCP method." },
            reason: { type: "string", description: "Required analyst/audit reason for calling the Shuffle MCP endpoint." }
          },
          required: ["method", "reason"],
          additionalProperties: false
        }
      }),
      async (args, context) => {
        const method = requireString(args, "method");
        const params = parseJsonObject(optionalString(args, "paramsJson"), "paramsJson");
        const reason = requireString(args, "reason");
        const raw = await clientFactory().callShuffleMcp({ method, params });
        const output = {
          policyDecision: `executed under ${context.actionLevel} access level`,
          endpointClass: "shuffle.mcp",
          method,
          params,
          reason,
          raw
        };
        return {
          output,
          artifacts: [artifact(`Shuffle MCP call: ${method}`, `Called Shuffle MCP method ${method}.`, output)]
        };
      }
    )
  ];

  function webhookTool(apiName: string, id: string, name: string, description: string): ShufflePluginTool {
    return new ShuffleTool(
      apiName,
      manifest({
        id,
        name,
        description,
        toolClass: "action",
        risk: "high",
        tags: ["shuffle", "webhook", "wazuh", "action"],
        inputSchema: {
          type: "object",
          properties: {
            webhookUrl: { type: "string", description: "Explicit Shuffle webhook URL copied from the Shuffle trigger." },
            payloadJson: { type: "string", description: "Optional JSON object payload. For Wazuh alerts, pass the alert JSON object." },
            headersJson: { type: "string", description: "Optional JSON object of header name/value pairs for webhook auth." },
            reason: { type: "string", description: "Required analyst/audit reason for triggering the webhook." }
          },
          required: ["webhookUrl", "reason"],
          additionalProperties: false
        }
      }),
      async (args, context) => {
        const webhookUrl = requireString(args, "webhookUrl");
        const payload = parseJsonObject(optionalString(args, "payloadJson"), "payloadJson");
        const headers = headerObject(parseJsonObject(optionalString(args, "headersJson"), "headersJson"));
        const reason = requireString(args, "reason");
        const raw = await clientFactory().triggerWebhook({
          webhookUrl,
          method: "POST",
          payload,
          headers
        });
        const output = {
          policyDecision: `executed under ${context.actionLevel} access level`,
          endpointClass: id,
          webhookHost: new URL(webhookUrl).host,
          reason,
          payload,
          raw
        };
        return {
          output,
          artifacts: [artifact(name, `Triggered Shuffle webhook on ${output.webhookHost}.`, output)]
        };
      }
    );
  }
}

function workflowListQuery(args: Record<string, unknown>): Record<string, string | number | undefined> {
  return {
    limit: boundedInteger(args, "limit", 50, 1, 500),
    query: optionalString(args, "query")
  };
}

function headerObject(value: Record<string, unknown>): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, current] of Object.entries(value)) {
    if (typeof current !== "string") {
      throw new Error("headersJson values must be strings");
    }
    headers[key] = current;
  }
  return headers;
}

function wazuhIntegrationInput(args: Record<string, unknown>) {
  const webhookUrl = validatedUrl(requireString(args, "webhookUrl"), "webhookUrl");
  const level = optionalLevel(args);
  const ruleId = optionalString(args, "ruleId");
  const group = optionalString(args, "group");
  const eventLocation = optionalString(args, "eventLocation");
  return {
    webhookUrl,
    ...(level !== undefined ? { level } : {}),
    ...(ruleId ? { ruleId } : {}),
    ...(group ? { group } : {}),
    ...(eventLocation ? { eventLocation } : {})
  };
}

function optionalLevel(args: Record<string, unknown>): number | undefined {
  const value = args.level;
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 16) {
    throw new Error("level must be an integer from 0 to 16");
  }
  return value;
}

function renderWazuhIntegrationXml(input: {
  webhookUrl: string;
  level?: number;
  ruleId?: string;
  group?: string;
  eventLocation?: string;
}): string {
  const lines = [
    "<integration>",
    "  <name>shuffle</name>",
    `  <hook_url>${escapeXml(input.webhookUrl)}</hook_url>`,
    "  <alert_format>json</alert_format>"
  ];
  if (input.level !== undefined) {
    lines.push(`  <level>${input.level}</level>`);
  }
  if (input.ruleId) {
    lines.push(`  <rule_id>${escapeXml(input.ruleId)}</rule_id>`);
  }
  if (input.group) {
    lines.push(`  <group>${escapeXml(input.group)}</group>`);
  }
  if (input.eventLocation) {
    lines.push(`  <event_location>${escapeXml(input.eventLocation)}</event_location>`);
  }
  lines.push("</integration>");
  return lines.join("\n");
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function memoizedShuffleClient(): () => ShuffleClient {
  let client: ShuffleClient | undefined;
  return () => {
    client ??= new ShuffleClient();
    return client;
  };
}

function emptySchema() {
  return {
    type: "object" as const,
    properties: {},
    required: [],
    additionalProperties: false
  };
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
    skillPackId: "secops-shuffle",
    defaultPermission: input.toolClass === "action" ? "ask" : "auto",
    mcpCompatible: true
  };
}
