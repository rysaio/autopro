import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { AgentRunEvent } from "@secops-agent/shared";

export class AuditLog {
  constructor(private readonly filePath: string) {}

  append(event: AgentRunEvent): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    appendFileSync(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
  }

  recent(limit = 100): AgentRunEvent[] {
    if (!existsSync(this.filePath)) {
      return [];
    }
    const normalizedLimit = Math.max(1, Math.min(limit, 500));
    return readFileSync(this.filePath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-normalizedLimit)
      .map((line) => JSON.parse(line) as AgentRunEvent);
  }
}
