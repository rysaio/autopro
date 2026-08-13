import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export type SkillVisibilityOverrides = Record<string, boolean>;

/**
 * 技能功能开关持久化：runtime/config/skillVisibility.json，键为技能 id，
 * 值为是否启用。缺失即启用（默认全开），与 ToolVisibilityStore 同构。
 */
export class SkillVisibilityStore {
  private visibility: SkillVisibilityOverrides;

  constructor(private readonly filePath: string) {
    this.visibility = this.load();
  }

  get(): SkillVisibilityOverrides {
    return { ...this.visibility };
  }

  isEnabled(id: string): boolean {
    return this.visibility[id] !== false;
  }

  set(id: string, enabled: boolean): void {
    this.visibility = { ...this.visibility, [id]: enabled };
    this.persist();
  }

  private load(): SkillVisibilityOverrides {
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
      throw new Error(`Invalid skill visibility config: ${this.filePath}`);
    }
    for (const [skillId, enabled] of Object.entries(parsed)) {
      if (!skillId || typeof enabled !== "boolean") {
        throw new Error(`Invalid skill visibility config: ${this.filePath}`);
      }
    }
    return { ...(parsed as SkillVisibilityOverrides) };
  }

  private persist(): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, `${JSON.stringify(this.visibility, null, 2)}\n`, "utf8");
  }
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
