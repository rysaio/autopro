import {
  Activity,
  AlertTriangle,
  Bot,
  CheckCircle2,
  DatabaseZap,
  Loader2,
  LockKeyhole,
  MessageSquare,
  Play,
  PlugZap,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  XCircle,
  Wrench
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import type {
  AgentRun,
  AgentRunEvent,
  ApprovalDecisionResult,
  AuditEvent,
  AutomationLevel,
  ChatMessage,
  EvidenceArtifact,
  PendingApproval,
  PermissionMode,
  ProviderStatus,
  SkillPackManifest,
  SkillManifest,
  ToolClass,
  ToolInvocation
} from "@secops-agent/shared";
import {
  approveToolCall,
  callMcpTool,
  denyToolCall,
  fetchApprovals,
  fetchAuditEvents,
  fetchHealth,
  fetchMcpTools,
  fetchSkills,
  fetchTools,
  streamAgent,
  updateActionLevel,
  type McpCallResult,
  type McpToolSummary
} from "./api.js";

const seedMessages: ChatMessage[] = [
  {
    id: "seed-assistant",
    role: "assistant",
    content: "Ready. Send me an alert, IOC, asset, or case goal. I will choose from the enabled skills, surface MCP/tool calls inline, and keep the audit trail attached to the run.",
    createdAt: new Date().toISOString()
  }
];

type InspectorTab = "plan" | "audit" | "artifacts" | "mcp";
type WorkbenchPanel = "skills" | InspectorTab;
type ToolClassFilter = ToolClass | "all";

const capabilityFilters: Array<{ id: ToolClassFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "perception", label: "Perception" },
  { id: "reasoning", label: "Reasoning" },
  { id: "evidence", label: "Evidence" },
  { id: "action", label: "Action" }
];

const actionLevels: Array<{ id: AutomationLevel; label: string }> = [
  { id: "observe", label: "Observe" },
  { id: "sandbox", label: "Sandbox" },
  { id: "full-access", label: "Full" }
];

export function App() {
  const [health, setHealth] = useState<ProviderStatus | null>(null);
  const [skillPacks, setSkillPacks] = useState<SkillPackManifest[]>([]);
  const [tools, setTools] = useState<SkillManifest[]>([]);
  const [mcpTools, setMcpTools] = useState<McpToolSummary[]>([]);
  const [enabledTools, setEnabledTools] = useState<Set<string>>(new Set());
  const [messages, setMessages] = useState<ChatMessage[]>(seedMessages);
  const [lastRun, setLastRun] = useState<AgentRun | null>(null);
  const [streamAudit, setStreamAudit] = useState<AuditEvent[]>([]);
  const [streamArtifacts, setStreamArtifacts] = useState<EvidenceArtifact[]>([]);
  const [streamToolInvocations, setStreamToolInvocations] = useState<ToolInvocation[]>([]);
  const [persistedAudit, setPersistedAudit] = useState<AuditEvent[]>([]);
  const [mcpResult, setMcpResult] = useState<McpCallResult | null>(null);
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>([]);
  const [prompt, setPrompt] = useState("Triage this security signal, explain which skills you used, and recommend the next safe action.");
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("ask");
  const [toolClassFilter, setToolClassFilter] = useState<ToolClassFilter>("all");
  const [toolQuery, setToolQuery] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [isMcpRunning, setIsMcpRunning] = useState(false);
  const [isUpdatingActionLevel, setIsUpdatingActionLevel] = useState(false);
  const [resolvingApprovalId, setResolvingApprovalId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<InspectorTab>("plan");
  const [activePanel, setActivePanel] = useState<WorkbenchPanel | null>(null);

  useEffect(() => {
    let mounted = true;
    Promise.all([fetchHealth(), fetchSkills(), fetchTools(), fetchMcpTools(), fetchApprovals(), fetchAuditEvents()])
      .then(([healthResult, skillsResult, toolsResult, mcpToolsResult, approvalsResult, auditResult]) => {
        if (!mounted) {
          return;
        }
        setHealth(healthResult);
        setSkillPacks(skillsResult);
        setTools(toolsResult);
        setMcpTools(mcpToolsResult);
        setPendingApprovals(approvalsResult);
        setPersistedAudit(auditEventsFromRunEvents(auditResult));
        setEnabledTools(new Set(healthResult.actionLevel === "full-access"
          ? toolsResult.map((tool) => tool.id)
          : defaultEnabledToolIds(toolsResult)));
        if (healthResult.actionLevel === "full-access") {
          setPermissionMode("auto");
        }
      })
      .catch((caught: unknown) => {
        if (mounted) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      });
    return () => {
      mounted = false;
    };
  }, []);

  const fullAccessActive = health?.actionLevel === "full-access";
  const enabledToolList = useMemo(
    () => fullAccessActive ? tools.map((tool) => tool.id) : [...enabledTools],
    [enabledTools, fullAccessActive, tools]
  );
  const effectivePermissionMode = fullAccessActive ? "auto" : permissionMode;
  const activeAudit = lastRun?.audit ?? streamAudit;
  const visibleAudit = activeAudit.length ? activeAudit : persistedAudit;
  const activeArtifacts = lastRun?.artifacts ?? streamArtifacts;
  const activeToolInvocations = lastRun?.toolInvocations ?? streamToolInvocations;
  const enabledSkillCount = enabledToolList.length;
  const enabledMcpCount = mcpTools.filter((tool) => enabledToolList.includes(tool.manifest.id)).length;
  const visibleTools = useMemo(() => {
    const query = toolQuery.trim().toLowerCase();
    return tools.filter((tool) => {
      const matchesClass = toolClassFilter === "all" || tool.toolClass === toolClassFilter;
      const searchable = `${tool.name} ${tool.id} ${tool.skillPackId} ${tool.toolClass} ${tool.risk} ${tool.tags.join(" ")}`.toLowerCase();
      return matchesClass && (!query || searchable.includes(query));
    });
  }, [toolClassFilter, toolQuery, tools]);

  async function refreshApprovals() {
    setPendingApprovals(await fetchApprovals());
  }

  async function refreshPersistedAudit() {
    setPersistedAudit(auditEventsFromRunEvents(await fetchAuditEvents()));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!prompt.trim() || isRunning) {
      return;
    }
    setIsRunning(true);
    setError(null);
    const nextMessages: ChatMessage[] = [
      ...messages,
      {
        id: crypto.randomUUID(),
        role: "user",
        content: prompt.trim(),
        createdAt: new Date().toISOString()
      }
    ];
    setMessages(nextMessages);
    setLastRun(null);
    setStreamAudit([]);
    setStreamArtifacts([]);
    setStreamToolInvocations([]);
    setPrompt("");
    try {
      const run = await streamAgent({
        messages: nextMessages.map((message) => ({
          role: message.role,
          content: message.content
        })),
        enabledTools: enabledToolList,
        permissionMode: effectivePermissionMode
      }, applyRunEvent);
      setLastRun(run);
      setMessages(run.messages);
      setStreamAudit(run.audit);
      setStreamArtifacts(run.artifacts);
      setStreamToolInvocations(run.toolInvocations);
      await refreshApprovals();
      await refreshPersistedAudit();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setIsRunning(false);
    }
  }

  function handlePromptKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
      return;
    }
    event.preventDefault();
    if (!prompt.trim() || isRunning) {
      return;
    }
    event.currentTarget.form?.requestSubmit();
  }

  function applyRunEvent(event: AgentRunEvent) {
    if (event.type === "audit" && event.audit) {
      setStreamAudit((current) => [...current, event.audit as AuditEvent]);
      return;
    }
    if (event.type === "artifact" && event.artifact) {
      setStreamArtifacts((current) => [...current, event.artifact as EvidenceArtifact]);
      return;
    }
    if (event.type === "tool" && event.invocation) {
      setStreamToolInvocations((current) => upsertInvocation(current, event.invocation as ToolInvocation));
      return;
    }
    if (event.type === "message" && event.message) {
      setMessages((current) => [...current, event.message as ChatMessage]);
    }
  }

  async function callMcp(name: string, args: Record<string, unknown>) {
    setIsMcpRunning(true);
    setError(null);
    try {
      const result = await callMcpTool(name, args, effectivePermissionMode);
      setMcpResult(result);
      setTab("mcp");
      await refreshApprovals();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setIsMcpRunning(false);
    }
  }

  async function changeActionLevel(actionLevel: AutomationLevel) {
    if (isUpdatingActionLevel || health?.actionLevel === actionLevel) {
      return;
    }
    setIsUpdatingActionLevel(true);
    setError(null);
    try {
      const settings = await updateActionLevel(actionLevel);
      setHealth((current) => current ? { ...current, actionLevel: settings.actionLevel } : current);
      if (settings.actionLevel === "full-access") {
        setPermissionMode("auto");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setIsUpdatingActionLevel(false);
    }
  }

  function toggleTool(id: string) {
    setEnabledTools((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function togglePack(packId: string) {
    const packToolIds = tools
      .filter((tool) => tool.skillPackId === packId)
      .map((tool) => tool.id);
    setEnabledTools((current) => {
      const next = new Set(current);
      const allEnabled = packToolIds.every((id) => next.has(id));
      for (const id of packToolIds) {
        if (allEnabled) {
          next.delete(id);
        } else {
          next.add(id);
        }
      }
      return next;
    });
  }

  function enabledCountForPack(pack: SkillPackManifest): number {
    if (fullAccessActive) {
      return pack.tools.length;
    }
    return pack.tools.filter((id) => enabledTools.has(id)).length;
  }

  function isPackFullyEnabled(pack: SkillPackManifest): boolean {
    if (fullAccessActive) {
      return pack.tools.length > 0;
    }
    return pack.tools.length > 0 && pack.tools.every((id) => enabledTools.has(id));
  }

  function enableVisibleTools() {
    setEnabledTools((current) => new Set([...current, ...visibleTools.map((tool) => tool.id)]));
  }

  function disableVisibleTools() {
    const visibleIds = new Set(visibleTools.map((tool) => tool.id));
    setEnabledTools((current) => new Set([...current].filter((id) => !visibleIds.has(id))));
  }

  function useReadOnlyScope() {
    setEnabledTools(new Set(tools.filter((tool) => tool.toolClass !== "action").map((tool) => tool.id)));
  }

  function disableActionTools() {
    const actionIds = new Set(tools.filter((tool) => tool.toolClass === "action").map((tool) => tool.id));
    setEnabledTools((current) => new Set([...current].filter((id) => !actionIds.has(id))));
  }

  async function resolveApproval(id: string, decision: "approve" | "deny") {
    setResolvingApprovalId(id);
    setError(null);
    try {
      const result = decision === "approve" ? await approveToolCall(id) : await denyToolCall(id);
      applyApprovalResult(result);
      await refreshApprovals();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setResolvingApprovalId(null);
    }
  }

  function applyApprovalResult(result: ApprovalDecisionResult) {
    setLastRun((current) => {
      if (!current) {
        return current;
      }
      const hadInvocation = current.toolInvocations.some((invocation) => invocation.id === result.invocation.id);
      const toolInvocations = current.toolInvocations.map((invocation) => (
        invocation.id === result.invocation.id ? result.invocation : invocation
      ));
      return {
        ...current,
        status: hadInvocation && !toolInvocations.some((invocation) => invocation.status === "pending_approval")
          ? "completed"
          : current.status,
        toolInvocations,
        artifacts: [...current.artifacts, ...result.artifacts],
        audit: [...current.audit, ...result.audit],
        messages: mergeMessages(current.messages, result.messages)
      };
    });
    setStreamToolInvocations((current) => upsertInvocation(current, result.invocation));
    setStreamArtifacts((current) => [...current, ...result.artifacts]);
    setStreamAudit((current) => [...current, ...result.audit]);
    setMessages((current) => mergeMessages(current, result.messages));
    setMcpResult((current) => (
      current?.invocation.id === result.invocation.id
        ? { invocation: result.invocation, artifacts: result.artifacts }
        : current
    ));
  }

  function togglePanel(panel: WorkbenchPanel) {
    setActivePanel((current) => current === panel ? null : panel);
    if (panel !== "skills") {
      setTab(panel);
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="SecOps skills">
        <div className="brand-row">
          <div className="brand-mark">
            <Bot size={22} aria-hidden="true" />
          </div>
          <div>
            <h1>SecOps Agent</h1>
            <p>Agent workspace</p>
          </div>
        </div>

        <div className="conversation-list" aria-label="Conversations">
          <div className="section-label">
            <MessageSquare size={14} aria-hidden="true" />
            <span>Conversations</span>
          </div>
          <button
            className={!activePanel ? "session-row active" : "session-row"}
            onClick={() => setActivePanel(null)}
            type="button"
          >
            <strong>Current investigation</strong>
            <small>{messages.length} messages · {activeToolInvocations.length} tool calls</small>
          </button>
          <p className="sidebar-empty">No saved conversations.</p>
        </div>

        <div className="nav-stack" aria-label="Workspace tools">
          <div className="section-label">
            <Settings2 size={14} aria-hidden="true" />
            <span>Workspace</span>
          </div>
          <button
            className={activePanel === "skills" ? "nav-item active" : "nav-item"}
            onClick={() => togglePanel("skills")}
            type="button"
          >
            <Wrench size={15} aria-hidden="true" />
            <span>Skills</span>
            <strong>{enabledSkillCount}/{tools.length}</strong>
          </button>
          <button
            className={activePanel === "mcp" ? "nav-item active" : "nav-item"}
            onClick={() => togglePanel("mcp")}
            type="button"
          >
            <PlugZap size={15} aria-hidden="true" />
            <span>MCP Tools</span>
            <strong>{mcpTools.length}</strong>
          </button>
          <button
            className={activePanel === "plan" ? "nav-item active" : "nav-item"}
            onClick={() => togglePanel("plan")}
            type="button"
          >
            <Activity size={15} aria-hidden="true" />
            <span>Activity</span>
            <strong>{activeToolInvocations.length}</strong>
          </button>
          <button
            className={activePanel === "audit" ? "nav-item active" : "nav-item"}
            onClick={() => togglePanel("audit")}
            type="button"
          >
            <ShieldCheck size={15} aria-hidden="true" />
            <span>Audit Trail</span>
            <strong>{visibleAudit.length}</strong>
          </button>
          <button
            className={activePanel === "artifacts" ? "nav-item active" : "nav-item"}
            onClick={() => togglePanel("artifacts")}
            type="button"
          >
            <DatabaseZap size={15} aria-hidden="true" />
            <span>Evidence</span>
            <strong>{activeArtifacts.length}</strong>
          </button>
        </div>

        <div className="provider-card">
          <div className="section-label">
            <Settings2 size={14} aria-hidden="true" />
            <span>Runtime</span>
          </div>
          <strong>{health?.model ?? "loading"}</strong>
          <div className="runtime-grid">
            <span>{health?.provider ?? "provider"}</span>
            <span>{health?.configured ? "configured" : "setup required"}</span>
            <span>{health?.capabilities.tools ? "tools on" : "tools off"}</span>
            <span>{health?.actionLevel ?? "sandbox"}</span>
          </div>
        </div>
      </aside>

      <main className={activePanel ? "main-panel config-mode" : "main-panel"}>
        {activePanel ? (
          <section className="config-workspace" aria-label={`${panelTitle(activePanel)} workspace`}>
            <header className="config-topbar">
              <button className="back-button" onClick={() => setActivePanel(null)} type="button">
                <MessageSquare size={16} aria-hidden="true" />
                <span>Back to chat</span>
              </button>
              <div>
                <h2>{panelTitle(activePanel)}</h2>
                <p>{panelSubtitle(activePanel, {
                  activeArtifacts,
                  activeToolInvocations,
                  enabledMcpCount,
                  enabledSkillCount,
                  mcpTools,
                  pendingApprovals,
                  tools,
                  visibleAudit
                })}</p>
              </div>
              {activePanel !== "skills" ? (
                <div className={`approval-dot ${pendingApprovals.length ? "active" : ""}`} title="Pending approvals">
                  {pendingApprovals.length}
                </div>
              ) : null}
            </header>

            {activePanel === "skills" ? (
              <div className="config-grid skills-config">
                <section className="config-section wide">
                  <div className="section-label">
                    <Wrench size={14} aria-hidden="true" />
                    <span>Run Scope</span>
                  </div>
                  <div className="scope-actions config-actions" aria-label="Run scope controls">
                    <button disabled={fullAccessActive} onClick={enableVisibleTools} type="button">
                      <Wrench size={15} aria-hidden="true" />
                      <span>Enable visible</span>
                    </button>
                    <button disabled={fullAccessActive} onClick={disableVisibleTools} type="button">
                      <XCircle size={15} aria-hidden="true" />
                      <span>Disable visible</span>
                    </button>
                    <button disabled={fullAccessActive} onClick={useReadOnlyScope} type="button">
                      <ShieldCheck size={15} aria-hidden="true" />
                      <span>Read-only</span>
                    </button>
                    <button disabled={fullAccessActive} onClick={disableActionTools} type="button">
                      <LockKeyhole size={15} aria-hidden="true" />
                      <span>Actions off</span>
                    </button>
                  </div>
                  <div className="section-label">
                    <Search size={14} aria-hidden="true" />
                    <span>Find skills</span>
                  </div>
                  <input
                    aria-label="Filter skills"
                    className="capability-search"
                    onChange={(event) => setToolQuery(event.target.value)}
                    placeholder="Filter skills..."
                    type="search"
                    value={toolQuery}
                  />
                  <div className="capability-filters" aria-label="Tool class filter">
                    {capabilityFilters.map((filter) => (
                      <button
                        aria-pressed={toolClassFilter === filter.id}
                        className={toolClassFilter === filter.id ? "active" : ""}
                        key={filter.id}
                        onClick={() => setToolClassFilter(filter.id)}
                        type="button"
                      >
                        {filter.label}
                      </button>
                    ))}
                  </div>
                </section>

                <section className="config-section">
                  <div className="section-label">
                    <PlugZap size={14} aria-hidden="true" />
                    <span>Skill Packs</span>
                  </div>
                  <div className="pack-list">
                    {skillPacks.map((pack) => (
                      <label className="pack-row pack-toggle" key={pack.id}>
                        <input
                          checked={isPackFullyEnabled(pack)}
                          disabled={fullAccessActive}
                          onChange={() => togglePack(pack.id)}
                          type="checkbox"
                        />
                        <span className="pack-copy">
                          <strong>{pack.name}</strong>
                          <small>{pack.version} · {enabledCountForPack(pack)}/{pack.tools.length} enabled</small>
                        </span>
                      </label>
                    ))}
                  </div>
                </section>

                <section className="config-section">
                  <div className="section-label">
                    <Wrench size={14} aria-hidden="true" />
                    <span>Skills</span>
                  </div>
                  <div className="tool-list">
                    {visibleTools.length ? visibleTools.map((tool) => (
                      <label className="tool-row" key={tool.id}>
                        <input
                          checked={fullAccessActive || enabledTools.has(tool.id)}
                          disabled={fullAccessActive}
                          onChange={() => toggleTool(tool.id)}
                          type="checkbox"
                        />
                        <span className="tool-copy">
                          <strong>{tool.name}</strong>
                          <small>{tool.skillPackId}</small>
                          <span className="tool-badges">
                            <em>{tool.toolClass}</em>
                            <em className={`risk-${tool.risk}`}>{tool.risk}</em>
                            {tool.mcpCompatible ? <em>MCP</em> : null}
                          </span>
                        </span>
                      </label>
                    )) : <p className="empty-state">No matching skills.</p>}
                  </div>
                </section>
              </div>
            ) : (
              <div className="config-inspector">
                <div className="inspector-tabs config-tabs" role="tablist" aria-label="Inspector views">
                  <button
                    aria-controls="panel-activity"
                    aria-selected={tab === "plan"}
                    className={tab === "plan" ? "active" : ""}
                    id="tab-activity"
                    onClick={() => {
                      setTab("plan");
                      setActivePanel("plan");
                    }}
                    role="tab"
                    type="button"
                  >
                    <Activity size={15} aria-hidden="true" />
                    <span>Activity</span>
                  </button>
                  <button
                    aria-controls="panel-audit"
                    aria-selected={tab === "audit"}
                    className={tab === "audit" ? "active" : ""}
                    id="tab-audit"
                    onClick={() => {
                      setTab("audit");
                      setActivePanel("audit");
                    }}
                    role="tab"
                    type="button"
                  >
                    <CheckCircle2 size={15} aria-hidden="true" />
                    <span>Audit</span>
                  </button>
                  <button
                    aria-controls="panel-artifacts"
                    aria-selected={tab === "artifacts"}
                    className={tab === "artifacts" ? "active" : ""}
                    id="tab-artifacts"
                    onClick={() => {
                      setTab("artifacts");
                      setActivePanel("artifacts");
                    }}
                    role="tab"
                    type="button"
                  >
                    <DatabaseZap size={15} aria-hidden="true" />
                    <span>Evidence</span>
                  </button>
                  <button
                    aria-controls="panel-mcp"
                    aria-selected={tab === "mcp"}
                    className={tab === "mcp" ? "active" : ""}
                    id="tab-mcp"
                    onClick={() => {
                      setTab("mcp");
                      setActivePanel("mcp");
                    }}
                    role="tab"
                    type="button"
                  >
                    <PlugZap size={15} aria-hidden="true" />
                    <span>MCP</span>
                  </button>
                </div>
                {tab === "plan" ? (
                  <div aria-labelledby="tab-activity" id="panel-activity" role="tabpanel">
                    <RunActivityView
                      artifacts={activeArtifacts}
                      audit={visibleAudit}
                      lastRun={lastRun}
                      messages={messages}
                      pendingApprovals={pendingApprovals}
                      toolInvocations={activeToolInvocations}
                    />
                  </div>
                ) : null}
                {tab === "audit" ? (
                  <div aria-labelledby="tab-audit" id="panel-audit" role="tabpanel">
                    <AuditView events={visibleAudit} />
                  </div>
                ) : null}
                {tab === "artifacts" ? (
                  <div aria-labelledby="tab-artifacts" id="panel-artifacts" role="tabpanel">
                    <ArtifactView artifacts={activeArtifacts} />
                  </div>
                ) : null}
                {tab === "mcp" ? (
                  <div aria-labelledby="tab-mcp" id="panel-mcp" role="tabpanel">
                    <McpView
                      isRunning={isMcpRunning}
                      mcpResult={mcpResult}
                      mcpTools={mcpTools}
                      onCall={callMcp}
                      onResolveApproval={resolveApproval}
                      permissionMode={effectivePermissionMode}
                      resolvingApprovalId={resolvingApprovalId}
                    />
                  </div>
                ) : null}
              </div>
            )}
          </section>
        ) : (
          <>
        <header className="topbar">
          <div>
            <h2>Agent Console</h2>
            <p>{enabledSkillCount} skills enabled · {enabledMcpCount} MCP-compatible · {health?.actionLevel ?? "sandbox"} access</p>
          </div>
          <div className="topbar-actions">
            <div className="segmented" aria-label="Permission mode">
              {(["auto", "ask", "deny"] as PermissionMode[]).map((mode) => (
                <button
                  aria-pressed={effectivePermissionMode === mode}
                  className={effectivePermissionMode === mode ? "active" : ""}
                  disabled={fullAccessActive}
                  key={mode}
                  onClick={() => setPermissionMode(mode)}
                  type="button"
                >
                  {mode}
                </button>
              ))}
            </div>
            <div className="segmented access-level" aria-label="Automation access level">
              {actionLevels.map((level) => (
                <button
                  aria-pressed={health?.actionLevel === level.id}
                  className={health?.actionLevel === level.id ? "active" : ""}
                  disabled={isUpdatingActionLevel}
                  key={level.id}
                  onClick={() => changeActionLevel(level.id)}
                  type="button"
                >
                  {level.label}
                </button>
              ))}
            </div>
            <StatusPill health={health} />
            <button
              className="icon-button"
              disabled={isRunning || !prompt.trim()}
              form="agent-composer"
              title="Run current prompt"
              type="submit"
            >
              <Play size={18} aria-hidden="true" />
            </button>
          </div>
        </header>

        {error ? (
          <div className="error-banner" role="alert">
            <AlertTriangle size={18} aria-hidden="true" />
            <span>{error}</span>
          </div>
        ) : null}

        <section className="chat-stage" aria-label="Agent conversation">
          <div className="transcript" aria-label="Agent transcript">
            {messages.map((message) => (
              <TranscriptMessage key={message.id} message={message} />
            ))}
            {activeToolInvocations.map((invocation) => (
              <ToolCallCard
                invocation={invocation}
                isResolving={resolvingApprovalId === invocation.id}
                key={invocation.id}
                onApprove={() => resolveApproval(invocation.id, "approve")}
                onDeny={() => resolveApproval(invocation.id, "deny")}
              />
            ))}
          </div>
        </section>

        <form className="composer" id="agent-composer" onSubmit={submit}>
          <div className="composer-meta">
            <Sparkles size={16} aria-hidden="true" />
            <span>{health?.provider ?? "provider"} · {health?.model ?? "model"}</span>
          </div>
          <textarea
            aria-label="Agent prompt"
            aria-keyshortcuts="Enter"
            onKeyDown={handlePromptKeyDown}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Ask the agent to investigate defensively..."
            rows={3}
            value={prompt}
          />
          <button className="send-button" disabled={isRunning || !prompt.trim()} id="composer-submit" type="submit">
            {isRunning ? <Loader2 className="spin" size={18} aria-hidden="true" /> : <Send size={18} aria-hidden="true" />}
            <span>Run</span>
          </button>
        </form>
          </>
        )}
      </main>

    </div>
  );
}

function StatusPill({ health }: { health: ProviderStatus | null }) {
  const healthy = Boolean(health?.configured);
  return (
    <div className={`status-pill ${healthy ? "ok" : "warn"}`}>
      {healthy ? <CheckCircle2 size={15} aria-hidden="true" /> : <AlertTriangle size={15} aria-hidden="true" />}
      <span>{healthy ? "configured" : "setup required"}</span>
    </div>
  );
}

function panelTitle(panel: WorkbenchPanel): string {
  if (panel === "skills") {
    return "Skills";
  }
  if (panel === "mcp") {
    return "MCP Tools";
  }
  if (panel === "audit") {
    return "Audit Trail";
  }
  if (panel === "artifacts") {
    return "Evidence";
  }
  return "Run Activity";
}

function panelSubtitle(
  panel: WorkbenchPanel,
  context: {
    activeArtifacts: EvidenceArtifact[];
    activeToolInvocations: ToolInvocation[];
    enabledMcpCount: number;
    enabledSkillCount: number;
    mcpTools: McpToolSummary[];
    pendingApprovals: PendingApproval[];
    tools: SkillManifest[];
    visibleAudit: AuditEvent[];
  }
): string {
  if (panel === "skills") {
    return `${context.enabledSkillCount}/${context.tools.length} enabled · ${context.enabledMcpCount} MCP-compatible in scope`;
  }
  if (panel === "mcp") {
    return `${context.mcpTools.length} tools · ${context.pendingApprovals.length} pending approvals`;
  }
  if (panel === "audit") {
    return `${context.visibleAudit.length} audit events`;
  }
  if (panel === "artifacts") {
    return `${context.activeArtifacts.length} evidence artifacts`;
  }
  return `${context.activeToolInvocations.length} tool calls · ${context.pendingApprovals.length} pending approvals`;
}

function TranscriptMessage({ message }: { message: ChatMessage }) {
  return (
    <article className={`message ${message.role}`}>
      <div className="avatar">{message.role === "user" ? "AN" : message.role === "tool" ? "TL" : "AG"}</div>
      <div className="message-body">
        <div className="message-meta">
          <strong>{message.name ?? labelForRole(message.role)}</strong>
          <time>{new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
        </div>
        <p>{message.content}</p>
      </div>
    </article>
  );
}

function labelForRole(role: ChatMessage["role"]) {
  if (role === "user") {
    return "Analyst";
  }
  if (role === "tool") {
    return "Tool";
  }
  return "Agent";
}

function auditEventsFromRunEvents(events: AgentRunEvent[]): AuditEvent[] {
  return events
    .map((event) => event.audit)
    .filter((event): event is AuditEvent => Boolean(event));
}

function defaultEnabledToolIds(tools: SkillManifest[]): string[] {
  return tools
    .filter((tool) => tool.risk !== "high")
    .map((tool) => tool.id);
}

function upsertInvocation(current: ToolInvocation[], invocation: ToolInvocation): ToolInvocation[] {
  if (current.some((item) => item.id === invocation.id)) {
    return current.map((item) => (item.id === invocation.id ? invocation : item));
  }
  return [...current, invocation];
}

function mergeMessages(current: ChatMessage[], nextMessages: ChatMessage[]): ChatMessage[] {
  const seen = new Set(current.map((message) => message.id));
  return [
    ...current,
    ...nextMessages.filter((message) => !seen.has(message.id))
  ];
}

function ToolCallCard({
  invocation,
  isResolving,
  onApprove,
  onDeny
}: {
  invocation: ToolInvocation;
  isResolving: boolean;
  onApprove: () => void;
  onDeny: () => void;
}) {
  const pending = invocation.status === "pending_approval";
  return (
    <div className={`tool-call ${pending ? "pending" : invocation.status}`} key={invocation.id}>
      <div className="tool-call-icon">
        <LockKeyhole size={16} aria-hidden="true" />
      </div>
      <div>
        <div className="tool-call-title">
          <strong>{invocation.displayName}</strong>
          <span>{invocation.status}</span>
        </div>
        {pending ? (
          <div className="approval-panel">
            <pre>{JSON.stringify(invocation.arguments, null, 2)}</pre>
            <div className="approval-actions">
              <button disabled={isResolving} onClick={onApprove} type="button">
                {isResolving ? <Loader2 className="spin" size={15} aria-hidden="true" /> : <CheckCircle2 size={15} aria-hidden="true" />}
                <span>Allow</span>
              </button>
              <button className="deny" disabled={isResolving} onClick={onDeny} type="button">
                <XCircle size={15} aria-hidden="true" />
                <span>Deny</span>
              </button>
            </div>
          </div>
        ) : (
          <pre>{JSON.stringify(invocation.result ?? invocation.error, null, 2)}</pre>
        )}
      </div>
    </div>
  );
}

type ActivitySeverity = "info" | "warn" | "error";

interface RunActivityItem {
  id: string;
  at: string;
  title: string;
  detail: string;
  kind: string;
  severity: ActivitySeverity;
}

function RunActivityView({
  lastRun,
  messages,
  audit,
  artifacts,
  pendingApprovals,
  toolInvocations
}: {
  lastRun: AgentRun | null;
  messages: ChatMessage[];
  audit: AuditEvent[];
  artifacts: EvidenceArtifact[];
  pendingApprovals: PendingApproval[];
  toolInvocations: ToolInvocation[];
}) {
  const activity = buildRunActivity({
    messages,
    audit,
    artifacts,
    pendingApprovals,
    toolInvocations
  });
  const runState = lastRun?.status ?? (toolInvocations.length ? "streaming" : "idle");
  return (
    <div className="inspector-body">
      <h3>Run Activity</h3>
      <div className="activity-summary">
        <span>{runState}</span>
        <span>{toolInvocations.length} tools</span>
        <span>{pendingApprovals.length} approvals</span>
      </div>
      <div className="activity-list">
        {activity.map((item) => (
          <article className={`activity-item ${item.severity}`} key={item.id}>
            <div className="activity-meta">
              <strong>{item.title}</strong>
              <span>{item.kind}</span>
            </div>
            <p>{item.detail}</p>
          </article>
        ))}
      </div>
    </div>
  );
}

function buildRunActivity(input: {
  messages: ChatMessage[];
  audit: AuditEvent[];
  artifacts: EvidenceArtifact[];
  pendingApprovals: PendingApproval[];
  toolInvocations: ToolInvocation[];
}): RunActivityItem[] {
  return [
    ...input.messages.map((message): RunActivityItem => ({
      id: `message-${message.id}`,
      at: message.createdAt,
      title: `${labelForRole(message.role)} message`,
      detail: compact(message.content),
      kind: "message",
      severity: "info"
    })),
    ...input.toolInvocations.map((invocation): RunActivityItem => ({
      id: `tool-${invocation.id}`,
      at: invocation.completedAt ?? invocation.startedAt,
      title: invocation.displayName,
      detail: `${invocation.status}: ${compact(JSON.stringify(invocation.result ?? invocation.error ?? invocation.arguments))}`,
      kind: invocation.toolName,
      severity: severityForInvocation(invocation)
    })),
    ...input.audit.map((event): RunActivityItem => ({
      id: `audit-${event.id}`,
      at: event.createdAt,
      title: event.label,
      detail: event.detail,
      kind: event.type,
      severity: event.severity
    })),
    ...input.artifacts.map((artifact): RunActivityItem => ({
      id: `artifact-${artifact.id}`,
      at: artifact.createdAt,
      title: artifact.title,
      detail: artifact.summary,
      kind: artifact.kind,
      severity: "info"
    })),
    ...input.pendingApprovals.map((approval): RunActivityItem => ({
      id: `approval-${approval.id}`,
      at: approval.requestedAt,
      title: approval.displayName,
      detail: `Pending approval for ${approval.toolName}`,
      kind: approval.risk,
      severity: "warn"
    }))
  ].sort((left, right) => new Date(right.at).getTime() - new Date(left.at).getTime());
}

function severityForInvocation(invocation: ToolInvocation): ActivitySeverity {
  if (invocation.status === "failed" || invocation.status === "denied") {
    return "error";
  }
  if (invocation.status === "pending_approval") {
    return "warn";
  }
  return "info";
}

function compact(value: string): string {
  return value.length > 180 ? `${value.slice(0, 177)}...` : value;
}

function AuditView({ events }: { events: AuditEvent[] }) {
  return (
    <div className="inspector-body">
      <h3>Audit Trail</h3>
      <div className="timeline">
        {events.length ? events.map((event) => (
          <div className={`timeline-item ${event.severity}`} key={event.id}>
            <strong>{event.label}</strong>
            <span>{event.detail}</span>
          </div>
        )) : <p className="empty-state">No run yet.</p>}
      </div>
    </div>
  );
}

function ArtifactView({ artifacts }: { artifacts: EvidenceArtifact[] }) {
  return (
    <div className="inspector-body">
      <h3>Evidence</h3>
      <div className="artifact-list">
        {artifacts.length ? artifacts.map((artifact) => (
          <article className="artifact" key={artifact.id}>
            <div className="artifact-kind">{artifact.kind}</div>
            <strong>{artifact.title}</strong>
            <p>{artifact.summary}</p>
          </article>
        )) : <p className="empty-state">No artifacts yet.</p>}
      </div>
    </div>
  );
}

function McpView({
  isRunning,
  mcpResult,
  mcpTools,
  onCall,
  onResolveApproval,
  permissionMode,
  resolvingApprovalId
}: {
  isRunning: boolean;
  mcpResult: McpCallResult | null;
  mcpTools: McpToolSummary[];
  onCall: (name: string, args: Record<string, unknown>) => void;
  onResolveApproval: (id: string, decision: "approve" | "deny") => void;
  permissionMode: PermissionMode;
  resolvingApprovalId: string | null;
}) {
  const [selectedToolName, setSelectedToolName] = useState("");
  const selectedTool = useMemo(() => (
    mcpTools.find((tool) => tool.name === selectedToolName) ?? mcpTools[0]
  ), [mcpTools, selectedToolName]);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!selectedTool) {
      return;
    }
    setSelectedToolName(selectedTool.name);
    setFieldValues(defaultValuesForManifest(selectedTool.manifest));
  }, [selectedTool?.name]);

  function submitMcpTool(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedTool || isRunning) {
      return;
    }
    onCall(selectedTool.name, argsFromManifest(selectedTool.manifest, fieldValues));
  }

  return (
    <div className="inspector-body">
      <h3>MCP Tools</h3>
      <form className="mcp-form" onSubmit={submitMcpTool}>
        <label className="mcp-field">
          <span>Tool</span>
          <select
            onChange={(event) => setSelectedToolName(event.target.value)}
            value={selectedTool?.name ?? ""}
          >
            {mcpTools.map((tool) => (
              <option key={tool.name} value={tool.name}>{tool.name}</option>
            ))}
          </select>
        </label>
        {selectedTool ? manifestFields(selectedTool.manifest).map(({ name, property, required }) => (
          <label className="mcp-field" key={name}>
            <span>{name}{required ? " *" : ""}</span>
            {fieldInput(property, fieldValues[name] ?? "", required, (value) => {
              setFieldValues((current) => ({ ...current, [name]: value }));
            })}
          </label>
        )) : null}
        <button disabled={isRunning || !selectedTool} type="submit">
          {isRunning ? <Loader2 className="spin" size={15} aria-hidden="true" /> : <PlugZap size={15} aria-hidden="true" />}
          <span>Call tool</span>
        </button>
      </form>
      <div className="mcp-list">
        {mcpTools.map((tool) => (
          <div className="mcp-row" key={tool.name}>
            <strong>{tool.name}</strong>
            <small>{tool.manifest.skillPackId} · {tool.manifest.toolClass} · {tool.manifest.risk}</small>
          </div>
        ))}
      </div>
      <div className="mcp-result">
        <div className="section-label">
          <PlugZap size={14} aria-hidden="true" />
          <span>{permissionMode} result</span>
        </div>
        {mcpResult ? (
          mcpResult.invocation.status === "pending_approval" ? (
            <ToolCallCard
              invocation={mcpResult.invocation}
              isResolving={resolvingApprovalId === mcpResult.invocation.id}
              onApprove={() => onResolveApproval(mcpResult.invocation.id, "approve")}
              onDeny={() => onResolveApproval(mcpResult.invocation.id, "deny")}
            />
          ) : (
            <pre>{JSON.stringify(mcpResult.invocation.result ?? mcpResult.invocation.error, null, 2)}</pre>
          )
        ) : <p className="empty-state">No MCP call yet.</p>}
      </div>
    </div>
  );
}

function manifestFields(manifest: SkillManifest) {
  const required = new Set(manifest.inputSchema.required ?? []);
  return Object.entries(manifest.inputSchema.properties)
    .filter(([, property]) => isRecord(property))
    .map(([name, property]) => ({
      name,
      property: property as Record<string, unknown>,
      required: required.has(name)
    }));
}

function defaultValuesForManifest(manifest: SkillManifest): Record<string, string> {
  const values: Record<string, string> = {};
  for (const { name, property } of manifestFields(manifest)) {
    const enumValues = Array.isArray(property.enum)
      ? property.enum.filter((value): value is string => typeof value === "string")
      : [];
    values[name] = enumValues[0] ?? "";
  }
  return values;
}

function argsFromManifest(manifest: SkillManifest, values: Record<string, string>): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const { name, property, required } of manifestFields(manifest)) {
    const raw = values[name] ?? "";
    const trimmed = raw.trim();
    if (property.type === "array" && isRecord(property.items) && property.items.type === "string") {
      if (trimmed || required) {
        args[name] = trimmed
          ? trimmed.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean)
          : [];
      }
      continue;
    }
    if (trimmed || required) {
      args[name] = trimmed;
    }
  }
  return args;
}

function fieldInput(
  property: Record<string, unknown>,
  value: string,
  required: boolean,
  onChange: (value: string) => void
) {
  const enumValues = Array.isArray(property.enum)
    ? property.enum.filter((item): item is string => typeof item === "string")
    : [];
  if (enumValues.length) {
    return (
      <select
        aria-required={required}
        onChange={(event) => onChange(event.target.value)}
        required={required}
        value={value}
      >
        {enumValues.map((item) => (
          <option key={item} value={item}>{item}</option>
        ))}
      </select>
    );
  }
  if (property.type === "array") {
    return (
      <textarea
        aria-required={required}
        onChange={(event) => onChange(event.target.value)}
        required={required}
        rows={3}
        value={value}
      />
    );
  }
  return (
    <input
      aria-required={required}
      onChange={(event) => onChange(event.target.value)}
      required={required}
      type="text"
      value={value}
    />
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
