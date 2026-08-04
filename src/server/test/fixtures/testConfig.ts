import path from "node:path";
import type { AgentRunRequest } from "@secops-agent/shared";
import type { LanguageModel } from "ai";
import { getConfig, type AppConfig } from "../../src/config.js";
import { createScriptedModel } from "./scriptedModel.js";

export function testConfig(env: NodeJS.ProcessEnv = {}): AppConfig {
  const testRunId = crypto.randomUUID();
  return getConfig({
    MODEL_PROVIDER: "test-provider",
    SECOPS_MODEL: "test-model",
    MODEL_API_KEY: "test-key",
    MODEL_BASE_URL: "https://provider.test/v1",
    SECOPS_RUNTIME_CONFIG_PATH: path.resolve("runtime", "tests", testRunId, "settings.json"),
    SECOPS_AUDIT_LOG_PATH: path.resolve("runtime", "tests", testRunId, "events.jsonl"),
    SECOPS_APPROVAL_STORE_PATH: path.resolve("runtime", "tests", testRunId, "pending-approvals.json"),
    // Tests opt out of the embedded durable store by default so each synthetic
    // server stays isolated (no shared runtime/pgdata, no leftover dirs). Tests
    // that exercise durable behaviour construct a PostgresSessionStore directly.
    SECOPS_DURABLE_SESSIONS: "off",
    ...env
  });
}

export function scriptedModelForRequest(_config: AppConfig, request: AgentRunRequest): LanguageModel {
  return createScriptedModel(latestUserText(request));
}

function latestUserText(request: AgentRunRequest): string {
  return [...request.messages].reverse().find((message) => message.role === "user")?.content ?? "";
}
