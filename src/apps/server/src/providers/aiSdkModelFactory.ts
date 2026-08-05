import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import type { ModelConnection } from "../runtime/modelConfigStore.js";

export function createAiSdkModel(connection: ModelConnection): LanguageModel {
  if (!connection.model || !connection.baseUrl) {
    throw new Error("Model provider is not configured.");
  }
  const provider = createOpenAICompatible({
    baseURL: connection.baseUrl,
    name: connection.provider,
    // apiKey 允许为空：支持本地无 key 的 OpenAI-compatible 端点
    apiKey: connection.apiKey ?? ""
  });

  return provider.chatModel(connection.model);
}
