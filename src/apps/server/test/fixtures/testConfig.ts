import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AgentRunRequest } from "@secops-agent/shared";
import type { LanguageModel } from "ai";
import { getConfig, type AppConfig } from "../../src/config.js";
import type { ModelConnection } from "../../src/runtime/modelConfigStore.js";
import { createScriptedModel } from "./scriptedModel.js";

export interface TestConfigOptions {
  /** 是否预置一条活动模型连接（默认 true）。设为 false 可测试“未配置模型”的启动/503 语义。 */
  withModel?: boolean;
}

export function testConfig(env: NodeJS.ProcessEnv = {}, options: TestConfigOptions = {}): AppConfig {
  const testRunId = crypto.randomUUID();
  const modelConfigPath = path.resolve("runtime", "tests", testRunId, "model.json");
  const credentialsPath = path.resolve("runtime", "tests", testRunId, ".credentials.yaml");
  if (options.withModel !== false) {
    mkdirSync(path.dirname(modelConfigPath), { recursive: true });
    writeFileSync(credentialsPath, [
      "credentials:",
      "  cred-test:",
      "    secret: test-key"
    ].join("\n") + "\n", "utf8");
    writeFileSync(modelConfigPath, JSON.stringify({
      connections: [{
        id: "test-conn",
        name: "Test Provider",
        provider: "test-provider",
        model: "test-model",
        baseUrl: "https://provider.test/v1",
        apiKeyCredentialId: "cred-test"
      }],
      activeConnectionId: "test-conn"
    }), "utf8");
  }
  return getConfig({
    SECOPS_RUNTIME_CONFIG_PATH: path.resolve("runtime", "tests", testRunId, "settings.json"),
    SECOPS_MODEL_CONFIG_PATH: modelConfigPath,
    SECOPS_CREDENTIALS_PATH: credentialsPath,
    SECOPS_MCP_CONFIG_PATH: path.resolve("runtime", "tests", testRunId, "mcp.json"),
    SECOPS_SKILLS_DIR: path.resolve("runtime", "tests", testRunId, "skills"),
    SECOPS_TOOL_VISIBILITY_PATH: path.resolve("runtime", "tests", testRunId, "toolVisibility.json"),
    SECOPS_SKILL_VISIBILITY_PATH: path.resolve("runtime", "tests", testRunId, "skillVisibility.json"),
    SECOPS_PLUGINS_DIR: path.resolve("runtime", "tests", testRunId, "plugins"),
    SECOPS_AUDIT_LOG_PATH: path.resolve("runtime", "tests", testRunId, "events.jsonl"),
    SECOPS_APPROVAL_STORE_PATH: path.resolve("runtime", "tests", testRunId, "pending-approvals.json"),
    // Tests opt out of the embedded durable store by default so each synthetic
    // server stays isolated (no shared runtime/pgdata, no leftover dirs). Tests
    // that exercise durable behaviour construct a PostgresSessionStore directly.
    SECOPS_DURABLE_SESSIONS: "off",
    ...env
  });
}

export function scriptedModelForRequest(_connection: ModelConnection, request: AgentRunRequest): LanguageModel {
  return createScriptedModel(latestUserText(request));
}

function latestUserText(request: AgentRunRequest): string {
  return [...request.messages].reverse().find((message) => message.role === "user")?.content ?? "";
}
