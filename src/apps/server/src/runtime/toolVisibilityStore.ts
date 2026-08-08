import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export type ToolVisibilityOverrides = Record<string, boolean>;

export class ToolVisibilityStore {
  private visibility: ToolVisibilityOverrides;

  constructor(private readonly filePath: string) {
    this.visibility = this.load();
  }

  get(): ToolVisibilityOverrides {
    return { ...this.visibility };
  }

  set(toolId: string, deferLoading: boolean): void {
    this.visibility = { ...this.visibility, [toolId]: deferLoading };
    this.persist();
  }

  clear(toolId: string): boolean {
    if (!Object.hasOwn(this.visibility, toolId)) {
      return false;
    }
    const next = { ...this.visibility };
    delete next[toolId];
    this.visibility = next;
    this.persist();
    return true;
  }

  private load(): ToolVisibilityOverrides {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as unknown;
    } catch (error) {
      if (isMissingFileError(error)) {
        return {};
      }
      throw error;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Invalid tool visibility config: ${this.filePath}`);
    }
    for (const [toolId, deferLoading] of Object.entries(parsed)) {
      if (!toolId || typeof deferLoading !== "boolean") {
        throw new Error(`Invalid tool visibility config: ${this.filePath}`);
      }
    }
    return { ...(parsed as ToolVisibilityOverrides) };
  }

  private persist(): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, `${JSON.stringify(this.visibility, null, 2)}\n`, "utf8");
  }
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
