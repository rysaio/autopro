export interface ModelToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ModelToolCall[];
}

export interface ModelTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface CompleteRequest {
  model: string;
  messages: ModelMessage[];
  tools?: ModelTool[];
  temperature?: number;
}

export interface CompleteResponse {
  message: ModelMessage;
  raw?: unknown;
}

export interface ModelProvider {
  readonly name: string;
  readonly capabilities: {
    tools: boolean;
    streaming: boolean;
    toolStreaming: boolean;
  };
  complete(request: CompleteRequest): Promise<CompleteResponse>;
}
