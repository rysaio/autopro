import { execFile } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { EvidenceArtifact, SkillManifest, ToolClass, ToolRisk } from "@secops-agent/shared";
import type { ModelTool } from "../providers/types.js";
import type { SecOpsTool, ToolContext, ToolExecutionResult } from "./types.js";

const execFileAsync = promisify(execFile);

type ToolHandler = (args: Record<string, unknown>, context: ToolContext) => Promise<ToolExecutionResult>;

class ActionTool implements SecOpsTool {
  constructor(
    readonly apiName: string,
    readonly manifest: SkillManifest,
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
        const cwd = typeof args.cwd === "string" && args.cwd.trim()
          ? path.resolve(args.cwd.trim())
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
  tags: string[];
  inputSchema: SkillManifest["inputSchema"];
}): SkillManifest {
  return {
    ...input,
    skillPackId: input.id === "full_access.exec" ? "secops-full-access" : "secops-actions",
    defaultPermission: input.risk === "high" ? "ask" : "auto",
    mcpCompatible: true
  };
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
    return { command: "npm", args: ["--version"] };
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
