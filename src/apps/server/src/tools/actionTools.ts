import { execFile } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { EvidenceArtifact, ToolManifest, ToolClass, ToolRisk } from "@secops-agent/shared";
import type { ModelTool } from "../providers/types.js";
import type { SecOpsTool, ToolContext, ToolExecutionResult } from "./types.js";
import { normalizePortablePath } from "../runtime/portablePath.js";

const execFileAsync = promisify(execFile);

type ToolHandler = (args: Record<string, unknown>, context: ToolContext) => Promise<ToolExecutionResult>;

class ActionTool implements SecOpsTool {
  constructor(
    readonly apiName: string,
    readonly manifest: ToolManifest,
    private readonly handler: ToolHandler
  ) {}

  toModelTool(): ModelTool {
    return {
      type: "function",
      function: {
        name: this.apiName,
        description: this.manifest.description,
        parameters: this.manifest.inputSchema
      }
    };
  }

  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
    return this.handler(args, context);
  }
}

export function createActionTools(): SecOpsTool[] {
  return [
    new ActionTool(
      "secops_case_note_write",
      manifest({
        id: "case.note.write",
        name: "Write Case Note",
        description:
          "Write a defensive case note into the configured local sandbox directory. This is a real filesystem action.",
        toolClass: "action",
        risk: "medium",
        tags: ["action", "sandbox", "case-note"],
        inputSchema: {
          type: "object",
          properties: {
            caseId: { type: "string", description: "Case identifier, e.g. INC-4821." },
            title: { type: "string", description: "Short note title." },
            body: { type: "string", description: "Markdown note body." }
          },
          required: ["caseId", "title", "body"],
          additionalProperties: false
        }
      }),
      async (args, context) => {
        const caseId = safeName(requireString(args, "caseId"));
        const title = requireString(args, "title");
        const body = requireString(args, "body");
        const caseDir = assertInside(context.sandboxRoot, path.join(context.sandboxRoot, "cases", caseId));
        await mkdir(caseDir, { recursive: true });
        const filePath = assertInside(caseDir, path.join(caseDir, `${Date.now()}-${safeName(title)}.md`));
        await writeFile(filePath, `# ${title}\n\n${body}\n`, "utf8");
        const output = {
          filePath,
          summary: `Wrote case note for ${caseId} inside sandbox.`
        };
        return {
          output,
          artifacts: [artifact("case_note", title, output.summary, output)]
        };
      }
    ),
    new ActionTool(
      "secops_command_run_sandbox",
      manifest({
        id: "command.run.sandbox",
        name: "Run Sandbox Command",
        description:
          "Run one preset low-risk local command for environment inspection. No arbitrary shell string is accepted.",
        toolClass: "action",
        risk: "medium",
        tags: ["action", "command", "sandbox"],
        inputSchema: {
          type: "object",
          properties: {
            commandId: {
              type: "string",
              enum: ["node_version", "npm_version", "git_status", "list_sandbox"],
              description: "Preset command to run."
            }
          },
          required: ["commandId"],
          additionalProperties: false
        }
      }),
      async (args, context) => runPresetCommand(requireString(args, "commandId"), context)
    ),
    new ActionTool(
      "secops_command_run_shell",
      manifest({
        id: "command.run.shell",
        name: "Run Shell Command",
        description:
          "Execute a real bash shell command inside the configured sandbox directory. The command runs with cwd=sandboxRoot and a 15 second timeout. Use this for CTF quizzes, local network requests with curl, file inspection, script execution, and other real command-line work. Output is truncated to 20k characters.",
        toolClass: "action",
        risk: "medium",
        deferLoading: false,
        tags: ["action", "shell", "sandbox", "ctf", "bash", "command"],
        inputSchema: {
          type: "object",
          properties: {
            command: {
              type: "string",
              description: "Bash shell command to execute inside the sandbox directory."
            }
          },
          required: ["command"],
          additionalProperties: false
        }
      }),
      async (args, context) => runShellCommand(requireString(args, "command"), context)
    ),
    new ActionTool(
      "secops_http_request",
      manifest({
        id: "http.request",
        name: "HTTP Request",
        description:
          "Make a real HTTP(S) request to a URL. Supports GET, POST, PUT, PATCH, DELETE, HEAD, and OPTIONS with optional JSON headers and body. Returns the response status, headers, and body truncated to 20k characters. Use for CTF quizzes, web API lookups, and real network reconnaissance.",
        toolClass: "action",
        risk: "medium",
        deferLoading: false,
        tags: ["action", "http", "network", "ctf", "requests", "web"],
        inputSchema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "Full HTTP(S) URL to request."
            },
            method: {
              type: "string",
              description: "HTTP method to use. Defaults to GET."
            },
            headers: {
              type: "object",
              additionalProperties: { type: "string" },
              description: "Optional request headers as string key-value pairs."
            },
            body: {
              type: "string",
              description: "Optional request body as a string. Pass JSON objects as a JSON string."
            }
          },
          required: ["url"],
          additionalProperties: false
        }
      }),
      async (args) => runHttpRequest(args)
    ),
    new ActionTool(
      "secops_full_access_exec",
      manifest({
        id: "full_access.exec",
        name: "Full Access Exec",
        description:
          "Execute an arbitrary local program with arguments. In full-access mode, cwd may point outside the workspace.",
        toolClass: "action",
        risk: "high",
        tags: ["action", "full-access", "dangerous"],
        inputSchema: {
          type: "object",
          properties: {
            command: { type: "string", description: "Program to execute without shell interpolation." },
            args: {
              type: "array",
              items: { type: "string" },
              description: "Arguments passed directly to the program."
            },
            cwd: { type: "string", description: "Optional working directory. Full access mode may point outside the workspace." }
          },
          required: ["command"],
          additionalProperties: false
        }
      }),
      async (args, context) => {
        const command = requireString(args, "command");
        // full_access.exec 允许模型/用户传入 cwd；从 Windows 迁到 WSL 后，
        // 旧调用里可能出现 C:\path，统一转成 /mnt/c/path 再交给 execFile。
        const cwd = typeof args.cwd === "string" && args.cwd.trim()
          ? path.resolve(normalizePortablePath(args.cwd.trim()))
          : context.workspaceRoot;
        const commandArgs = Array.isArray(args.args)
          ? args.args.filter((arg): arg is string => typeof arg === "string")
          : [];
        const { stdout, stderr } = await execFileAsync(command, commandArgs, {
          cwd,
          timeout: 10_000,
          maxBuffer: 128_000
        });
        return {
          output: {
            command,
            args: commandArgs,
            cwd,
            stdout: stdout.slice(0, 20_000),
            stderr: stderr.slice(0, 20_000)
          }
        };
      }
    )
  ];
}

function manifest(input: {
  id: string;
  name: string;
  description: string;
  toolClass: ToolClass;
  risk: ToolRisk;
  deferLoading?: boolean;
  tags: string[];
  inputSchema: ToolManifest["inputSchema"];
}): ToolManifest {
  return {
    ...input,
    deferLoading: input.deferLoading ?? true,
    mcpCompatible: true
  };
}

async function runShellCommand(command: string, context: ToolContext): Promise<ToolExecutionResult> {
  await mkdir(context.sandboxRoot, { recursive: true });
  const shell = process.platform === "win32"
    ? process.env.ComSpec || "cmd.exe"
    : "bash";
  const shellArgs = process.platform === "win32"
    ? ["/d", "/s", "/c", command]
    : ["-lc", command];
  const { stdout, stderr } = await execFileAsync(shell, shellArgs, {
    cwd: context.sandboxRoot,
    timeout: 15_000,
    maxBuffer: 1_000_000,
    env: process.env as Record<string, string>
  });
  return {
    output: {
      command,
      shell,
      cwd: context.sandboxRoot,
      stdout: stdout.slice(0, 20_000),
      stderr: stderr.slice(0, 20_000)
    }
  };
}

async function runHttpRequest(args: Record<string, unknown>): Promise<ToolExecutionResult> {
  const url = requireHttpUrl(requireString(args, "url"));
  const rawMethod = typeof args.method === "string" && args.method.trim()
    ? args.method.trim().toUpperCase()
    : "GET";
  const allowedMethods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
  if (!allowedMethods.has(rawMethod)) {
    throw new Error(`Unsupported HTTP method: ${rawMethod}`);
  }
  const headers = stringRecord(args.headers);
  const body = rawMethod === "GET" || rawMethod === "HEAD"
    ? undefined
    : args.body !== undefined
      ? typeof args.body === "string" ? args.body : JSON.stringify(args.body)
      : undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const requestInit: RequestInit = {
      method: rawMethod,
      headers,
      signal: controller.signal,
      redirect: "follow"
    };
    if (body !== undefined) {
      requestInit.body = body;
    }
    const response = await fetch(url, requestInit);
    const text = await response.text();
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });
    return {
      output: {
        url,
        method: rawMethod,
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
        body: text.slice(0, 20_000),
        size: text.length
      }
    };
  } finally {
    clearTimeout(timer);
  }
}

function requireHttpUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`URL must use http or https: ${rawUrl}`);
  }
  return parsed.toString();
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") {
      result[key] = entry;
    }
  }
  return result;
}

async function runPresetCommand(commandId: string, context: ToolContext): Promise<ToolExecutionResult> {
  if (commandId === "list_sandbox") {
    await mkdir(context.sandboxRoot, { recursive: true });
    const entries = await readdir(context.sandboxRoot, { withFileTypes: true });
    return {
      output: {
        commandId,
        sandboxRoot: context.sandboxRoot,
        entries: entries.map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? "directory" : "file"
        }))
      }
    };
  }

  const preset = commandPreset(commandId);
  const { stdout, stderr } = await execFileAsync(preset.command, preset.args, {
    cwd: context.workspaceRoot,
    timeout: 10_000,
    maxBuffer: 128_000
  });
  return {
    output: {
      commandId,
      command: preset.command,
      args: preset.args,
      stdout: stdout.slice(0, 20_000),
      stderr: stderr.slice(0, 20_000)
    }
  };
}

function commandPreset(commandId: string): { command: string; args: string[] } {
  if (commandId === "node_version") {
    return { command: "node", args: ["--version"] };
  }
  if (commandId === "npm_version") {
    // Windows 下 npm 是 npm.cmd；WSL/Linux 下直接是 npm。
    return { command: process.platform === "win32" ? "npm.cmd" : "npm", args: ["--version"] };
  }
  if (commandId === "git_status") {
    return { command: "git", args: ["status", "--short"] };
  }
  throw new Error(`Unsupported sandbox commandId: ${commandId}`);
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Expected non-empty string argument: ${key}`);
  }
  return value.trim();
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "note";
}

function assertInside(root: string, candidate: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  if (resolvedCandidate !== resolvedRoot && !resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("Sandbox path escape blocked");
  }
  return resolvedCandidate;
}

function artifact(
  kind: EvidenceArtifact["kind"],
  title: string,
  summary: string,
  data: unknown
): EvidenceArtifact {
  return {
    id: crypto.randomUUID(),
    kind,
    title,
    summary,
    data,
    createdAt: new Date().toISOString()
  };
}
