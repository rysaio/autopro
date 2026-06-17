import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { missingModelConfig, type AppConfig } from "../config.js";

export function createAiSdkModel(config: AppConfig): LanguageModel {
  const missing = missingModelConfig(config);
  if (missing.length) {
    throw new Error(`Model provider is not configured. Missing: ${missing.join(", ")}.`);
  }
  const modelBaseUrl = config.modelBaseUrl;
  const modelApiKey = config.modelApiKey;
  const model = config.model;
  if (!modelBaseUrl || !modelApiKey || !model) {
    throw new Error("Model provider is not configured.");
  }
  const provider = createOpenAICompatible({
    baseURL: modelBaseUrl,
    name: config.provider,
    apiKey: modelApiKey
  });

  return provider.chatModel(model);
}
