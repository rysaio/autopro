import { describe, expect, it } from "vitest";
import { createShuffleTools, type ShuffleExecutionContext, ShuffleClient } from "../src/index.js";

const expectedManifests = [
  "shuffle.config.status",
  "shuffle.health",
  "shuffle.workflows.list",
  "shuffle.workflow.get",
  "shuffle.workflow.execute",
  "shuffle.workflow.executions.list",
  "shuffle.execution.result.get",
  "shuffle.apps.list",
  "shuffle.wazuh.integration.render",
  "shuffle.webhook.trigger",
  "shuffle.wazuh.alert.forward",
  "shuffle.mcp.call"
];

const expectedApiNames = [
  "secops_shuffle_config_status",
  "secops_shuffle_health",
  "secops_shuffle_workflows_list",
  "secops_shuffle_workflow_get",
  "secops_shuffle_workflow_execute",
  "secops_shuffle_workflow_executions_list",
  "secops_shuffle_execution_result_get",
  "secops_shuffle_apps_list",
  "secops_shuffle_wazuh_integration_render",
  "secops_shuffle_webhook_trigger",
  "secops_shuffle_wazuh_alert_forward",
  "secops_shuffle_mcp_call"
];

describe("shuffle plugin tools", () => {
  it("exports current Shuffle manifest ids and API names", () => {
    const tools = createShuffleTools(() => fakeClient());

    expect(tools.map((tool) => tool.manifest.id)).toEqual(expectedManifests);
    expect(tools.map((tool) => tool.apiName)).toEqual(expectedApiNames);
    expect(tools.every((tool) => tool.manifest.skillPackId === "secops-shuffle")).toBe(true);
    expect(tools.every((tool) => tool.manifest.mcpCompatible)).toBe(true);
    expect(tools.find((tool) => tool.manifest.id === "shuffle.workflow.execute")?.manifest.defaultPermission).toBe("ask");
  });

  it("summarizes workflow list responses", async () => {
    const tool = createShuffleTools(() => fakeClient()).find((candidate) => candidate.manifest.id === "shuffle.workflows.list");

    const result = await tool?.execute({ limit: 5 }, context());

    expect(result?.output).toMatchObject({
      endpointClass: "shuffle.workflows",
      count: 1,
      workflows: [{ id: "wf-1", name: "Wazuh alert triage" }]
    });
    expect(result?.artifacts?.[0]?.kind).toBe("runtime");
  });

  it("passes JSON arguments to workflow execution", async () => {
    const fake = fakeClient();
    const tool = createShuffleTools(() => fake).find((candidate) => candidate.manifest.id === "shuffle.workflow.execute");

    const result = await tool?.execute(
      {
        workflowId: "wf-1",
        executionArgumentJson: "{\"alert\":{\"rule\":{\"id\":\"5710\"}}}",
        reason: "test execution"
      },
      context()
    );

    expect(result?.output).toMatchObject({
      workflowId: "wf-1",
      reason: "test execution",
      executionArgument: { alert: { rule: { id: "5710" } } }
    });
    expect(fake.executedWorkflowBody()).toEqual({ alert: { rule: { id: "5710" } } });
  });

  it("validates JSON object payloads before webhook calls", async () => {
    const tool = createShuffleTools(() => fakeClient()).find((candidate) => candidate.manifest.id === "shuffle.webhook.trigger");

    await expect(
      tool?.execute(
        {
          webhookUrl: "https://shuffle.example/api/v1/hooks/webhook-1",
          payloadJson: "[1,2,3]",
          reason: "bad payload"
        },
        context()
      )
    ).rejects.toThrow("payloadJson must be a JSON object");
  });

  it("renders Wazuh Shuffle integration XML without editing Wazuh files", async () => {
    const tool = createShuffleTools(() => fakeClient()).find((candidate) => candidate.manifest.id === "shuffle.wazuh.integration.render");

    const result = await tool?.execute(
      {
        webhookUrl: "https://shuffle.example/api/v1/hooks/webhook-1",
        level: 3,
        ruleId: "5710",
        group: "authentication_failed"
      },
      context()
    );

    expect(result?.output).toMatchObject({
      endpointClass: "shuffle.wazuh.integration",
      webhookHost: "shuffle.example",
      alertFormat: "json"
    });
    expect(JSON.stringify(result?.output)).toContain("<name>shuffle</name>");
    expect(JSON.stringify(result?.output)).toContain("<alert_format>json</alert_format>");
    expect(JSON.stringify(result?.output)).toContain("<rule_id>5710</rule_id>");
  });

  it("forwards Wazuh alert payloads to explicit Shuffle webhooks", async () => {
    const fake = fakeClient();
    const tool = createShuffleTools(() => fake).find((candidate) => candidate.manifest.id === "shuffle.wazuh.alert.forward");

    const result = await tool?.execute(
      {
        webhookUrl: "https://shuffle.example/api/v1/hooks/webhook-1",
        payloadJson: "{\"rule\":{\"id\":\"5710\"}}",
        headersJson: "{\"X-Shuffle-Auth\":\"test\"}",
        reason: "wazuh alert test"
      },
      context()
    );

    expect(result?.output).toMatchObject({
      endpointClass: "shuffle.wazuh.alert.forward",
      webhookHost: "shuffle.example",
      payload: { rule: { id: "5710" } }
    });
    expect(fake.webhookPayload()).toEqual({ rule: { id: "5710" } });
    expect(fake.webhookHeaders()).toEqual({ "X-Shuffle-Auth": "test" });
  });
});

function fakeClient() {
  let executedBody: Record<string, unknown> | undefined;
  let webhookPayloadValue: Record<string, unknown> | undefined;
  let webhookHeadersValue: Record<string, string> | undefined;
  return {
    endpointHost: () => "shuffle.example",
    health: async () => [{ id: "wf-1" }],
    listWorkflows: async () => [{ id: "wf-1", name: "Wazuh alert triage" }],
    getWorkflow: async (workflowId: string) => ({ id: workflowId, name: "Wazuh alert triage" }),
    executeWorkflow: async (_workflowId: string, body: Record<string, unknown>) => {
      executedBody = body;
      return { execution_id: "exec-1", status: "EXECUTING" };
    },
    listWorkflowExecutions: async () => [{ execution_id: "exec-1", status: "FINISHED" }],
    getExecutionResult: async () => ({ success: true }),
    listApps: async () => [{ id: "app-1", name: "Wazuh" }],
    callShuffleMcp: async (body: Record<string, unknown>) => ({ jsonrpc: "2.0", result: body }),
    triggerWebhook: async (input: { payload?: Record<string, unknown>; headers?: Record<string, string> }) => {
      webhookPayloadValue = input.payload;
      webhookHeadersValue = input.headers;
      return { ok: true };
    },
    executedWorkflowBody: () => executedBody,
    webhookPayload: () => webhookPayloadValue,
    webhookHeaders: () => webhookHeadersValue
  } as unknown as ShuffleClient & {
    executedWorkflowBody: () => Record<string, unknown> | undefined;
    webhookPayload: () => Record<string, unknown> | undefined;
    webhookHeaders: () => Record<string, string> | undefined;
  };
}

function context(): ShuffleExecutionContext {
  return {
    runId: "test-run",
    permissionMode: "auto",
    actionLevel: "full-access"
  };
}
