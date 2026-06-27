#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createWazuhMcpServer } from "../adapters/mcpServer.js";

const server = createWazuhMcpServer();
await server.connect(new StdioServerTransport());
