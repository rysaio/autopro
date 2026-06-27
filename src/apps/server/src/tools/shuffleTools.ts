import {
  ShuffleClient,
  createShuffleTools as createPluginShuffleTools,
  type ShufflePluginTool
} from "@secops-agent/shuffle-secops";
import type { ModelTool } from "../providers/types.js";
import type { SecOpsTool, ToolContext, ToolExecutionResult } from "./types.js";

class ShuffleToolAdapter implements SecOpsTool {
  readonly apiName: string;
  readonly manifest: SecOpsTool["manifest"];

  constructor(private readonly tool: ShufflePluginTool) {
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

export function createShuffleTools(clientFactory: () => ShuffleClient = memoizedShuffleClient()): SecOpsTool[] {
  return createPluginShuffleTools(clientFactory).map((tool) => new ShuffleToolAdapter(tool));
}

function memoizedShuffleClient(): () => ShuffleClient {
  let client: ShuffleClient | undefined;
  return () => {
    client ??= new ShuffleClient();
    return client;
  };
}
