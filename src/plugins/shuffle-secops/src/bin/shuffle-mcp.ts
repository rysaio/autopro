#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createShuffleMcpServer } from "../adapters/mcpServer.js";

const server = createShuffleMcpServer();
await server.connect(new StdioServerTransport());
