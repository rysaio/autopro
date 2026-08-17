import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import path from "node:path";
import type { AgentRunEvent } from "@secops-agent/shared";

/**
 * 审计日志：以追加模式打开一次文件描述符，后续 append 直接 writeSync。
 * 相比每次 appendFileSync（open + write + close），在大量事件写入时减少文件打开开销，
 * 同时保持同步、有序、可随时读取（recent）的语义。
 */
export class AuditLog {
  private fd: number | undefined;

  constructor(private readonly filePath: string) {}

  append(event: AgentRunEvent): void {
    this.writeLine(`${JSON.stringify(event)}\n`);
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

  close(): void {
    if (this.fd === undefined) {
      return;
    }
    closeSync(this.fd);
    this.fd = undefined;
  }

  private ensureFd(): number {
    if (this.fd !== undefined) {
      return this.fd;
    }
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.fd = openSync(this.filePath, "a");
    return this.fd;
  }

  private writeLine(line: string): void {
    const fd = this.ensureFd();
    const buffer = Buffer.from(line, "utf8");
    let offset = 0;
    while (offset < buffer.length) {
      offset += writeSync(fd, buffer, offset, buffer.length - offset);
    }
  }
}
