import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AutomationLevel, RuntimeSettings } from "@secops-agent/shared";

export class RuntimeSettingsStore {
  private settings: RuntimeSettings;

  constructor(
    private readonly filePath: string,
    defaults: RuntimeSettings
  ) {
    this.settings = this.load(defaults);
  }

  get(): RuntimeSettings {
    return { ...this.settings };
  }

  setActionLevel(actionLevel: AutomationLevel): RuntimeSettings {
    this.settings = { ...this.settings, actionLevel };
    this.persist();
    return this.get();
  }

  private load(defaults: RuntimeSettings): RuntimeSettings {
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<RuntimeSettings>;
      if (!isAutomationLevel(parsed.actionLevel)) {
        throw new Error(`Invalid actionLevel in ${this.filePath}`);
      }
      return { actionLevel: parsed.actionLevel };
    } catch (error) {
      if (isMissingFileError(error)) {
        return defaults;
      }
      throw error;
    }
  }

  private persist(): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, `${JSON.stringify(this.settings, null, 2)}\n`, "utf8");
  }
}

export function isAutomationLevel(value: unknown): value is AutomationLevel {
  return value === "observe" || value === "sandbox" || value === "full-access";
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
