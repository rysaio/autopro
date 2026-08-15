import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const sandboxRoot = process.env.SECOPS_SANDBOX_ROOT || process.cwd();
mkdirSync(sandboxRoot, { recursive: true });
const shell = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "bash";
const shellArgs = (command) => process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-lc", command];

const server = new McpServer({ name: "shell-secops", version: "0.1.0" }, { capabilities: { tools: {} } });

server.registerTool(
  "run_shell",
  {
    title: "Run Shell Command",
    description:
      "Execute a real bash shell command inside the host-provided sandbox directory (SECOPS_SANDBOX_ROOT). Useful for CTF quizzes, file inspection, local network requests via curl, and script execution. Returns stdout and stderr truncated to 20k characters.",
    inputSchema: {
      command: z.string().min(1).describe("Shell command to execute inside the sandbox directory.")
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
  async ({ command }) => {
    const { stdout, stderr } = await execFileAsync(shell, shellArgs(command), {
      cwd: sandboxRoot,
      timeout: 15_000,
      maxBuffer: 1_000_000
    });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            command,
            cwd: sandboxRoot,
            stdout: stdout.slice(0, 20_000),
            stderr: stderr.slice(0, 20_000)
          }, null, 2)
        }
      ]
    };
  }
);

await server.connect(new StdioServerTransport());
