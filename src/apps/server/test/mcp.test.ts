import { rm } from "node:fs/promises";
import path from "node:path";
import type { ToolManifest } from "@secops-agent/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/app.js";
import { mcpInputSchemaForManifest } from "../src/mcp/secopsMcpServer.js";
import { testConfig } from "./fixtures/testConfig.js";

describe("MCP facade", () => {
  it("fails fast for unsupported manifest input schemas", () => {
    const base: ToolManifest = {
      id: "unsupported.test",
      name: "Unsupported",
      description: "Test tool with unsupported inputs.",
      toolClass: "perception",
      risk: "low",
      deferLoading: false,
      tags: ["test"],
      mcpCompatible: true,
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false
      }
    };

    // required key that is not in properties
    const unsupportedRequired: ToolManifest = {
      ...base,
      id: "unsupported.required",
      inputSchema: {
        type: "object",
        properties: {
          existing: { type: "string" }
        },
        required: ["missingKey"],
        additionalProperties: false
      }
    };
    const mixedEnum: ToolManifest = {
      ...base,
      id: "unsupported.enum",
      inputSchema: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["safe", 1] }
        },
        required: ["mode"],
        additionalProperties: false
      }
    };

    // unsupportedRequired has "missingKey" in required but not in properties
    expect(() => mcpInputSchemaForManifest(unsupportedRequired)).toThrow("missing");
    expect(() => mcpInputSchemaForManifest(mixedEnum)).toThrow("Unsupported MCP enum schema");
  });

  it("lists tools and can call a sandbox action tool", async () => {
    const sandboxRoot = path.resolve("runtime/mcp-test-sandbox");
    await rm(sandboxRoot, { recursive: true, force: true });
    const app = buildServer(testConfig({
      SECOPS_ACTION_LEVEL: "sandbox",
      SECOPS_SANDBOX_ROOT: sandboxRoot
    }));

    const listResponse = await app.inject({
      method: "GET",
      url: "/api/mcp/tools"
    });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json().tools).toHaveLength(16);

    const removedEndpoint = await app.inject({
      method: "GET",
      url: "/api/mcp/tool-packs"
    });
    expect(removedEndpoint.statusCode).toBe(404);

    await app.close();
    await rm(sandboxRoot, { recursive: true, force: true });
  });
});
