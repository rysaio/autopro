import {
  WazuhClient,
  WazuhIndexerClient,
  DemoWazuhClient,
  DemoWazuhIndexerClient,
  isWazuhDemoMode,
  createWazuhTools as createPluginWazuhTools,
  type WazuhPluginTool
} from "@secops-agent/wazuh-secops";
import type { ModelTool } from "../providers/types.js";
import type { SecOpsTool, ToolContext, ToolExecutionResult } from "./types.js";

class WazuhToolAdapter implements SecOpsTool {
  readonly apiName: string;
  readonly manifest: SecOpsTool["manifest"];

  constructor(private readonly tool: WazuhPluginTool) {
    this.apiName = tool.apiName;
    this.manifest = tool.manifest;
  }

  toModelTool(): ModelTool {
    return this.tool.toModelTool();
  }

  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
    return this.tool.execute(args, context);
  }
}

export function createWazuhTools(
  clientFactory: () => WazuhClient | DemoWazuhClient = memoizedWazuhClient(),
  indexerClientFactory: () => WazuhIndexerClient | DemoWazuhIndexerClient = memoizedWazuhIndexerClient()
): SecOpsTool[] {
  return createPluginWazuhTools(clientFactory, indexerClientFactory).map((tool) => new WazuhToolAdapter(tool));
}

function memoizedWazuhClient(): () => WazuhClient | DemoWazuhClient {
  let client: WazuhClient | DemoWazuhClient | undefined;
  return () => {
    if (!client) {
      client = isWazuhDemoMode() ? new DemoWazuhClient() : new WazuhClient();
    }
    return client;
  };
}

function memoizedWazuhIndexerClient(): () => WazuhIndexerClient | DemoWazuhIndexerClient {
  let client: WazuhIndexerClient | DemoWazuhIndexerClient | undefined;
  return () => {
    if (!client) {
      client = isWazuhDemoMode() ? new DemoWazuhIndexerClient() : new WazuhIndexerClient();
    }
    return client;
  };
}