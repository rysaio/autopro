import { describe, expect, it } from "vitest";
import { buildServer } from "../src/app.js";
import { testConfig } from "./fixtures/testConfig.js";

describe("tool catalog API", () => {
  it("exposes the Wazuh skill pack and executable tools for the web console", async () => {
    const app = buildServer(testConfig());

    const skillsResponse = await app.inject({
      method: "GET",
      url: "/api/skills"
    });
    expect(skillsResponse.statusCode).toBe(200);
    expect(skillsResponse.json().skills).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "secops-wazuh",
        name: "Wazuh Platform",
        mcpCompatible: true,
        tools: expect.arrayContaining([
          "wazuh.agent.netaddr.list",
          "wazuh.agent.netiface.list",
          "wazuh.agent.network.summary",
          "wazuh.agent.ports.list",
          "wazuh.agent.processes.list",
          "wazuh.alerts.search",
          "wazuh.block_ip",
          "wazuh.config.status",
          "wazuh.host.neighbors",
          "wazuh.ip.activity.timeline",
          "wazuh.lateral.path.summary",
          "wazuh.lateral.suspects",
          "wazuh.network.exposure.map",
          "wazuh.network.service.find",
          "wazuh.rule.hits.summary"
        ])
      })
    ]));

    const toolsResponse = await app.inject({
      method: "GET",
      url: "/api/tools"
    });
    expect(toolsResponse.statusCode).toBe(200);
    const wazuhTools = toolsResponse.json().tools.filter((tool: { skillPackId: string }) => tool.skillPackId === "secops-wazuh");
    expect(wazuhTools.map((tool: { id: string }) => tool.id)).toEqual([
      "wazuh.config.status",
      "wazuh.health",
      "wazuh.agents.list",
      "wazuh.agent.get",
      "wazuh.agent.netaddr.list",
      "wazuh.agent.netiface.list",
      "wazuh.agent.ports.list",
      "wazuh.agent.processes.list",
      "wazuh.agent.network.summary",
      "wazuh.alerts.search",
      "wazuh.network.exposure.map",
      "wazuh.rule.hits.summary",
      "wazuh.agent.alerts.timeline",
      "wazuh.ip.activity.timeline",
      "wazuh.network.service.find",
      "wazuh.host.neighbors",
      "wazuh.lateral.suspects",
      "wazuh.lateral.path.summary",
      "wazuh.block_ip"
    ]);
    expect(wazuhTools.find((tool: { id: string }) => tool.id === "wazuh.block_ip")).toMatchObject({
      toolClass: "action",
      risk: "high",
      defaultPermission: "ask"
    });
    expect(wazuhTools.filter((tool: { toolClass: string }) => tool.toolClass === "perception")).toHaveLength(15);

    await app.close();
  });
});
