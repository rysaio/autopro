import { randomUUID } from "node:crypto";
import type {
  AgentRun,
  AgentRunEvent,
  AuditEvent,
  ChatMessage,
  EvidenceArtifact,
  ToolGuidance,
  ToolInvocation
} from "@secops-agent/shared";

export interface StateMarker {
  id: string;
  sessionId: string;
  runId: string;
  key: string;
  value: unknown;
  createdAt: string;
}

export interface SessionStateStore {
  startRun(input: { sessionId: string; runId: string; startedAt: string }): Promise<void>;
  appendMessage(sessionId: string, runId: string, message: ChatMessage): Promise<void>;
  recordToolInvocation(
    sessionId: string,
    runId: string,
    invocation: ToolInvocation,
    artifacts: EvidenceArtifact[]
  ): Promise<void>;
  recordGuidance(sessionId: string, runId: string, toolCallId: string, guidance: ToolGuidance): Promise<void>;
  recordAuditEvent(sessionId: string, runId: string, audit: AuditEvent): Promise<void>;
  recordRunEvent(event: AgentRunEvent): Promise<void>;
  recordStateMarkers(
    sessionId: string,
    runId: string,
    markers: Array<Omit<StateMarker, "id" | "sessionId" | "runId" | "createdAt">>
  ): Promise<void>;
  listStateMarkers(sessionId: string): Promise<StateMarker[]>;
  completeRun(sessionId: string, run: AgentRun): Promise<void>;
}

export class NoopSessionStateStore implements SessionStateStore {
  async startRun(): Promise<void> {}
  async appendMessage(): Promise<void> {}
  async recordToolInvocation(): Promise<void> {}
  async recordGuidance(): Promise<void> {}
  async recordAuditEvent(): Promise<void> {}
  async recordRunEvent(): Promise<void> {}
  async recordStateMarkers(): Promise<void> {}
  async listStateMarkers(): Promise<StateMarker[]> {
    return [];
  }
  async completeRun(): Promise<void> {}
}

export class MemorySessionStateStore implements SessionStateStore {
  readonly runs: Array<{ sessionId: string; runId: string; startedAt: string; completed?: AgentRun }> = [];
  readonly markers: StateMarker[] = [];
  readonly events: AgentRunEvent[] = [];
  readonly messages: ChatMessage[] = [];
  readonly invocations: ToolInvocation[] = [];
  readonly artifacts: EvidenceArtifact[] = [];
  readonly guidance: ToolGuidance[] = [];
  readonly audit: AuditEvent[] = [];

  async startRun(input: { sessionId: string; runId: string; startedAt: string }): Promise<void> {
    this.runs.push(input);
  }

  async appendMessage(_sessionId: string, _runId: string, message: ChatMessage): Promise<void> {
    this.messages.push(message);
  }

  async recordToolInvocation(
    _sessionId: string,
    _runId: string,
    invocation: ToolInvocation,
    artifacts: EvidenceArtifact[]
  ): Promise<void> {
    this.invocations.push(invocation);
    this.artifacts.push(...artifacts);
  }

  async recordGuidance(_sessionId: string, _runId: string, _toolCallId: string, guidance: ToolGuidance): Promise<void> {
    this.guidance.push(guidance);
  }

  async recordAuditEvent(_sessionId: string, _runId: string, audit: AuditEvent): Promise<void> {
    this.audit.push(audit);
  }

  async recordRunEvent(event: AgentRunEvent): Promise<void> {
    this.events.push(event);
  }

  async recordStateMarkers(
    sessionId: string,
    runId: string,
    markers: Array<Omit<StateMarker, "id" | "sessionId" | "runId" | "createdAt">>
  ): Promise<void> {
    for (const marker of markers) {
      this.markers.push({
        id: randomUUID(),
        sessionId,
        runId,
        createdAt: new Date().toISOString(),
        ...marker
      });
    }
  }

  async listStateMarkers(sessionId: string): Promise<StateMarker[]> {
    return this.markers.filter((marker) => marker.sessionId === sessionId);
  }

  async completeRun(sessionId: string, run: AgentRun): Promise<void> {
    const started = this.runs.find((candidate) => candidate.sessionId === sessionId && candidate.runId === run.id);
    if (started) {
      started.completed = run;
    }
  }
}
