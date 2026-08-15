import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { lookup, resolve4, resolve6, resolveMx, resolveTxt } from "node:dns/promises";

const server = new McpServer({ name: "network-secops", version: "0.1.0" }, { capabilities: { tools: {} } });

server.registerTool(
  "http_request",
  {
    title: "HTTP Request",
    description:
      "Make a real HTTP(S) request to a URL. Supports GET, POST, PUT, PATCH, DELETE, HEAD, and OPTIONS with custom headers and JSON/text body. Returns status, response headers, and body truncated to 20k characters.",
    inputSchema: {
      url: z.string().url().describe("Full HTTP(S) URL to request."),
      method: z.string().trim().toUpperCase().default("GET").describe("HTTP method. Defaults to GET."),
      headers: z.record(z.string(), z.string()).optional().describe("Optional request headers."),
      body: z.string().optional().describe("Optional request body as a string. Pass JSON objects as a JSON string.")
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true
    },
    _meta: {
      risk: "medium",
      toolClass: "action",
      deferLoading: true
    }
  },
  async ({ url, method, headers, body }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const requestInit = {
        method,
        headers: headers ?? {},
        signal: controller.signal,
        redirect: "follow"
      };
      if (body !== undefined && method !== "GET" && method !== "HEAD") {
        requestInit.body = typeof body === "string" ? body : JSON.stringify(body);
      }
      const response = await fetch(url, requestInit);
      const text = await response.text();
      const responseHeaders = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              url,
              method,
              status: response.status,
              statusText: response.statusText,
              headers: responseHeaders,
              body: text.slice(0, 20_000),
              size: text.length
            }, null, 2)
          }
        ]
      };
    } finally {
      clearTimeout(timer);
    }
  }
);

server.registerTool(
  "dns_lookup",
  {
    title: "DNS Lookup",
    description:
      "Perform real DNS lookups (A, AAAA, MX, TXT, or default address lookup) for a hostname. Returns the resolved records.",
    inputSchema: {
      hostname: z.string().min(1).describe("Hostname or domain to resolve."),
      type: z.enum(["default", "A", "AAAA", "MX", "TXT"]).default("default").describe("DNS record type to query.")
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    },
    _meta: {
      risk: "low",
      toolClass: "perception",
      deferLoading: false
    }
  },
  async ({ hostname, type }) => {
    const records = type === "default"
      ? await lookup(hostname, { all: true })
      : type === "A"
        ? await resolve4(hostname)
        : type === "AAAA"
          ? await resolve6(hostname)
          : type === "MX"
            ? await resolveMx(hostname)
            : await resolveTxt(hostname);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ hostname, type, records }, null, 2)
        }
      ]
    };
  }
);

await server.connect(new StdioServerTransport());
