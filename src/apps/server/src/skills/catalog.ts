import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync
} from "node:fs";
import path from "node:path";
import type { SkillContent, SkillSource, SkillSummary } from "@secops-agent/shared";
import { parse } from "yaml";

const DEFAULT_MAX_SKILL_BYTES = 128 * 1024;
const VALID_SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/;

export interface PluginSkillSource {
  pluginId: string;
  pluginRoot: string;
  skillsRoot: string;
}

export interface SkillCatalogOptions {
  standaloneRoot: string;
  maxSkillBytes?: number;
}

interface LoadedSkill {
  summary: SkillSummary;
  content?: string;
}

interface ScanSource {
  source: SkillSource;
  root: string;
  idPrefix: string;
  pluginId?: string;
  allowedRoot: string;
  required: boolean;
}

export class SkillCatalog {
  private snapshot = new Map<string, LoadedSkill>();
  private readonly maxSkillBytes: number;

  constructor(private readonly options: SkillCatalogOptions) {
    this.maxSkillBytes = options.maxSkillBytes ?? DEFAULT_MAX_SKILL_BYTES;
  }

  reload(pluginSources: PluginSkillSource[] = []): SkillSummary[] {
    const next = new Map<string, LoadedSkill>();
    const sources: ScanSource[] = [{
      source: "standalone",
      root: this.options.standaloneRoot,
      allowedRoot: this.options.standaloneRoot,
      idPrefix: "",
      required: false
    }, ...pluginSources.map((source) => ({
      source: "plugin" as const,
      root: source.skillsRoot,
      allowedRoot: source.pluginRoot,
      idPrefix: `${source.pluginId}:`,
      pluginId: source.pluginId,
      required: true
    }))];

    for (const source of sources) {
      for (const skill of scanSource(source, this.maxSkillBytes)) {
        const existing = next.get(skill.summary.id);
        if (existing) {
          next.set(skill.summary.id, {
            summary: errorSummary(
              skill.summary.id,
              skill.summary.name,
              skill.summary.source,
              "Duplicate skill id",
              skill.summary.pluginId
            )
          });
          continue;
        }
        next.set(skill.summary.id, skill);
      }
    }

    this.snapshot = next;
    return this.list();
  }

  list(): SkillSummary[] {
    return [...this.snapshot.values()]
      .map((skill) => ({ ...skill.summary }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  read(id: string): SkillContent | undefined {
    const skill = this.snapshot.get(id);
    if (!skill?.content || skill.summary.status !== "loaded") {
      return undefined;
    }
    return {
      ...skill.summary,
      status: "loaded",
      content: skill.content
    };
  }

  promptSummary(): string {
    const loaded = this.list().filter((skill) => skill.status === "loaded");
    if (!loaded.length) {
      return "";
    }
    return [
      "Available skills (metadata only; call secops_skill_read with an id before following a skill):",
      ...loaded.map((skill) => `- ${skill.id}: ${skill.name} - ${skill.description}`)
    ].join("\n");
  }
}

function scanSource(source: ScanSource, maxSkillBytes: number): LoadedSkill[] {
  if (!existsSync(source.root)) {
    return source.required ? [sourceError(source, "Declared skills directory does not exist")] : [];
  }
  try {
    const allowedRoot = realpathSync(source.allowedRoot);
    const root = realpathSync(source.root);
    if (lstatSync(source.root).isSymbolicLink() || !isWithin(allowedRoot, root)) {
      return [sourceError(source, "Declared skills directory is outside the plugin root")];
    }
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => loadSkill(source, root, entry.name, maxSkillBytes));
  } catch (error) {
    return [sourceError(source, safeError(error, "Failed to scan skills directory"))];
  }
}

function loadSkill(source: ScanSource, root: string, directoryName: string, maxSkillBytes: number): LoadedSkill {
  const id = `${source.idPrefix}${directoryName}`;
  const summaryError = (message: string): LoadedSkill => ({
    summary: errorSummary(id, directoryName, source.source, message, source.pluginId)
  });
  if (!VALID_SKILL_NAME.test(directoryName)) {
    return summaryError("Skill directory name must use lowercase letters, numbers, and hyphens");
  }
  try {
    const skillDirectory = path.join(root, directoryName);
    if (lstatSync(skillDirectory).isSymbolicLink()) {
      return summaryError("Symbolic links are not allowed for skill directories");
    }
    const filePath = path.join(skillDirectory, "SKILL.md");
    if (!existsSync(filePath)) {
      return summaryError("SKILL.md is missing");
    }
    if (lstatSync(filePath).isSymbolicLink()) {
      return summaryError("Symbolic links are not allowed for SKILL.md");
    }
    const realFile = realpathSync(filePath);
    if (!isWithin(root, realFile)) {
      return summaryError("SKILL.md is outside the declared skills directory");
    }
    if (statSync(realFile).size > maxSkillBytes) {
      return summaryError(`SKILL.md exceeds the ${maxSkillBytes} byte limit`);
    }
    const parsed = parseSkillFile(readFileSync(realFile, "utf8"));
    if (parsed.name !== directoryName) {
      return summaryError("Skill frontmatter name must match its directory name");
    }
    return {
      summary: {
        id,
        name: parsed.name,
        description: parsed.description,
        source: source.source,
        status: "loaded",
        ...(source.pluginId ? { pluginId: source.pluginId } : {})
      },
      content: parsed.content
    };
  } catch (error) {
    return summaryError(safeError(error, "Failed to load SKILL.md"));
  }
}

function parseSkillFile(input: string): { name: string; description: string; content: string } {
  const normalized = input.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines[0] !== "---") {
    throw new Error("SKILL.md must start with YAML frontmatter");
  }
  const closing = lines.indexOf("---", 1);
  if (closing === -1) {
    throw new Error("SKILL.md frontmatter is not closed");
  }
  const metadata = parse(lines.slice(1, closing).join("\n")) as unknown;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("Skill frontmatter must be a YAML object");
  }
  const record = metadata as Record<string, unknown>;
  if (typeof record.name !== "string" || !record.name.trim()) {
    throw new Error("Skill frontmatter requires name");
  }
  if (typeof record.description !== "string" || !record.description.trim()) {
    throw new Error("Skill frontmatter requires description");
  }
  const content = lines.slice(closing + 1).join("\n").trim();
  if (!content) {
    throw new Error("SKILL.md body is empty");
  }
  return {
    name: record.name.trim(),
    description: record.description.trim(),
    content
  };
}

function sourceError(source: ScanSource, message: string): LoadedSkill {
  const id = source.pluginId ? `${source.pluginId}:skills` : "standalone:skills";
  return {
    summary: errorSummary(id, "skills", source.source, message, source.pluginId)
  };
}

function errorSummary(
  id: string,
  name: string,
  source: SkillSource,
  error: string,
  pluginId?: string
): SkillSummary {
  return {
    id,
    name,
    description: "",
    source,
    status: "error",
    error,
    ...(pluginId ? { pluginId } : {})
  };
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function safeError(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || !error.message) {
    return fallback;
  }
  return error.message.replace(/[A-Za-z]:\\[^\s]+/g, "<path>");
}
