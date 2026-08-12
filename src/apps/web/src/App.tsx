import {
  Activity,
  AlertTriangle,
  Archive,
  ArchiveRestore,
  BarChart3,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clipboard,
  Copy,
  DatabaseZap,
  Download,
  FileText,
  LayoutDashboard,
  Loader2,
  LockKeyhole,
  MessageSquare,
  Network,
  Play,
  PlugZap,
  Plus,
  Search,
  Send,
  Server,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  XCircle,
  Wrench
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import type {
  AgentRun,
  AgentRunEvent,
  AgentSessionDetail,
  AgentSessionSummary,
  ApprovalDecisionResult,
  AuditEvent,
  AutomationLevel,
  ChatMessage,
  EvidenceArtifact,
  McpServerConfigState,
  PendingApproval,
  PermissionMode,
  PluginSummary,
  ProviderStatus,
  SkillSummary,
  ToolManifest,
  ToolClass,
  ToolInvocation
} from "@secops-agent/shared";
import {
  approveToolCall,
  archiveSession,
  callMcpTool,
  deleteSession,
  denyToolCall,
  fetchApprovals,
  fetchAuditEvents,
  fetchHealth,
  fetchMcpTools,
  fetchMcpServers,
  fetchPlugins,
  fetchSkills,
  fetchSession,
  fetchSessions,
  fetchTools,
  streamAgent,
  unarchiveSession,
  updateActionLevel,
  generateReport,
  exportReport,
  reloadPlugins,
  reloadSkills,
  type GenerateReportRequest,
  type GenerateReportResponse,
  type ExportReportRequest,
  type ExportReportResponse,
  type McpCallResult,
  type McpToolSummary
} from "./api.js";
import { KnowledgeGraphView } from "./KnowledgeGraphView.js";
import { ModelConfigView } from "./ModelConfigView.js";
import { McpServerConfigView } from "./McpServerConfigView.js";
import { PluginView } from "./PluginView.js";
import { SkillView } from "./SkillView.js";

const seedMessages: ChatMessage[] = [
  {
    id: "seed-assistant",
    role: "assistant",
    content: "就绪。发送告警、IOC、资产或案件目标给我，我会从启用的工具中选择合适的执行入口，并在对话中展示调用过程，同时保留完整的审计追踪。",
    createdAt: new Date().toISOString()
  }
];

const WORKSPACE_MIN_HEIGHT = 200;
const WORKSPACE_DEFAULT_RATIO = 0.4;
const WORKSPACE_DEFAULT_MAX = 520;
const WORKSPACE_MAX_VIEWPORT_MARGIN = 120;
const WORKSPACE_KEYBOARD_STEP = 24;
const WORKSPACE_KEYBOARD_FAST_STEP = 96;

function workspaceMaxHeight(): number {
  if (typeof window === "undefined") {
    return WORKSPACE_DEFAULT_MAX;
  }
  return Math.max(WORKSPACE_MIN_HEIGHT, window.innerHeight - WORKSPACE_MAX_VIEWPORT_MARGIN);
}

function clampWorkspaceHeight(height: number): number {
  return Math.round(Math.min(Math.max(height, WORKSPACE_MIN_HEIGHT), workspaceMaxHeight()));
}

function defaultWorkspaceHeight(): number {
  if (typeof window === "undefined") {
    return WORKSPACE_DEFAULT_MAX;
  }
  return clampWorkspaceHeight(
    Math.min(window.innerHeight * WORKSPACE_DEFAULT_RATIO, Math.min(WORKSPACE_DEFAULT_MAX, workspaceMaxHeight()))
  );
}

type InspectorTab = "plan" | "audit" | "artifacts";
type WorkbenchPanel = "archived" | "plugins" | "skills" | "tools" | "dashboard" | "knowledge-graph" | "model-config" | InspectorTab;
type ToolClassFilter = ToolClass | "all";

const toolClassFilters: Array<{ id: ToolClassFilter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "perception", label: "感知" },
  { id: "reasoning", label: "推理" },
  { id: "evidence", label: "取证" },
  { id: "action", label: "行动" }
];

const actionLevels: Array<{ id: AutomationLevel; label: string }> = [
  { id: "observe", label: "观察" },
  { id: "sandbox", label: "沙箱" },
  { id: "full-access", label: "完全" }
];

export function App() {
  const [health, setHealth] = useState<ProviderStatus | null>(null);
  const [plugins, setPlugins] = useState<PluginSummary[]>([]);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [tools, setTools] = useState<ToolManifest[]>([]);
  const [mcpTools, setMcpTools] = useState<McpToolSummary[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServerConfigState>({ servers: [] });
  const [archivedSessions, setArchivedSessions] = useState<AgentSessionSummary[]>([]);
  const [enabledTools, setEnabledTools] = useState<Set<string>>(new Set());
  const [messages, setMessages] = useState<ChatMessage[]>(seedMessages);
  const [currentSessionId, setCurrentSessionId] = useState<string>(() => crypto.randomUUID());
  const [sessions, setSessions] = useState<AgentSessionSummary[]>([]);
  const [activeSession, setActiveSession] = useState<AgentSessionDetail | null>(null);
  const [lastRun, setLastRun] = useState<AgentRun | null>(null);
  const [streamAudit, setStreamAudit] = useState<AuditEvent[]>([]);
  const [streamArtifacts, setStreamArtifacts] = useState<EvidenceArtifact[]>([]);
  const [streamToolInvocations, setStreamToolInvocations] = useState<ToolInvocation[]>([]);
  const [persistedAudit, setPersistedAudit] = useState<AuditEvent[]>([]);
  const [mcpResult, setMcpResult] = useState<McpCallResult | null>(null);
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>([]);
  const [prompt, setPrompt] = useState("请对这个安全信号进行分类，说明你使用了哪些工具，并推荐下一步安全操作。");
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("ask");
  const [toolClassFilter, setToolClassFilter] = useState<ToolClassFilter>("all");
  const [toolQuery, setToolQuery] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [isMcpRunning, setIsMcpRunning] = useState(false);
  const [isLoadingSession, setIsLoadingSession] = useState(false);
  const [isUpdatingActionLevel, setIsUpdatingActionLevel] = useState(false);
  const [isGeneratingReport, setIsGeneratingReport] = useState(false);
  const [reportDialogOpen, setReportDialogOpen] = useState(false);
  const [reportTitle, setReportTitle] = useState("");
  const [reportSeverity, setReportSeverity] = useState<"low" | "medium" | "high" | "critical">("medium");
  const [generatedReport, setGeneratedReport] = useState<unknown>(null);
  const [exportFormat, setExportFormat] = useState<"markdown" | "json">("markdown");
  const [exportedContent, setExportedContent] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [resolvingApprovalId, setResolvingApprovalId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<InspectorTab>("plan");
  const [activePanel, setActivePanel] = useState<WorkbenchPanel | null>(null);
  const [toolWorkspaceTab, setToolWorkspaceTab] = useState<"scope" | "mcp">("scope");
  const [workspaceHeight, setWorkspaceHeight] = useState<number>(defaultWorkspaceHeight);
  const [isResizingWorkspace, setIsResizingWorkspace] = useState(false);
  const workspaceHeightRef = useRef(workspaceHeight);
  const workspaceStackRef = useRef<HTMLDivElement | null>(null);
  const workspaceResizeStart = useRef<{ pointerId: number; y: number; height: number } | null>(null);

  useEffect(() => {
    workspaceHeightRef.current = workspaceHeight;
  }, [workspaceHeight]);

  useEffect(() => {
    function clampToViewport() {
      const viewportMax = workspaceMaxHeight();
      setWorkspaceHeight((current) => Math.min(current, viewportMax));
    }

    window.addEventListener("resize", clampToViewport);
    return () => window.removeEventListener("resize", clampToViewport);
  }, []);

  useEffect(() => {
    let mounted = true;
    Promise.all([
      fetchHealth(),
      fetchPlugins(),
      fetchSkills(),
      fetchTools(),
      fetchMcpTools(),
      fetchMcpServers(),
      fetchSessions(50, true),
      fetchApprovals(),
      fetchAuditEvents(),
      fetchSessions()
    ])
      .then(([healthResult, pluginsResult, skillsResult, toolsResult, mcpToolsResult, mcpServersResult, archivedSessionsResult, approvalsResult, auditResult, sessionsResult]) => {
        if (!mounted) {
          return;
        }
        setHealth(healthResult);
        setPlugins(pluginsResult);
        setSkills(skillsResult);
        setTools(toolsResult);
        setMcpTools(mcpToolsResult);
        setMcpServers(mcpServersResult);
        setArchivedSessions(archivedSessionsResult);
        setPendingApprovals(approvalsResult);
        setPersistedAudit(auditEventsFromRunEvents(auditResult));
        setSessions(sessionsResult);
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

  // 当前会话（未保存）在真实对话发生（至少一条用户消息）后，左侧才显示标题
  const liveConversationActive = !sessions.some((session) => session.id === currentSessionId) && messages.length > 1;
  const fullAccessActive = health?.actionLevel === "full-access";
  const enabledToolList = useMemo(
    () => fullAccessActive ? tools.map((tool) => tool.id) : [...enabledTools],
    [enabledTools, fullAccessActive, tools]
  );
  const effectivePermissionMode = fullAccessActive ? "auto" : permissionMode;
  const activeAudit = lastRun?.audit ?? (streamAudit.length ? streamAudit : activeSession?.audit ?? []);
  const visibleAudit = activeAudit.length ? activeAudit : persistedAudit;
  const activeArtifacts = lastRun?.artifacts ?? (streamArtifacts.length ? streamArtifacts : activeSession?.artifacts ?? []);
  const activeToolInvocations = lastRun?.toolInvocations ?? (
    streamToolInvocations.length ? streamToolInvocations : activeSession?.toolInvocations ?? []
  );
  const enabledToolCount = enabledToolList.length;
  const enabledMcpCount = mcpTools.filter((tool) => enabledToolList.includes(tool.manifest.id)).length;
  const visibleTools = useMemo(() => {
    const query = toolQuery.trim().toLowerCase();
    return tools.filter((tool) => {
      const matchesClass = toolClassFilter === "all" || tool.toolClass === toolClassFilter;
      const searchable = `${tool.name} ${tool.id} ${tool.toolClass} ${tool.risk} ${tool.tags.join(" ")}`.toLowerCase();
      return matchesClass && (!query || searchable.includes(query));
    });
  }, [toolClassFilter, toolQuery, tools]);

  async function refreshApprovals() {
    setPendingApprovals(await fetchApprovals());
  }

  async function refreshPersistedAudit() {
    setPersistedAudit(auditEventsFromRunEvents(await fetchAuditEvents()));
  }

  async function refreshSessions() {
    const [active, archived] = await Promise.all([
      fetchSessions(),
      fetchSessions(50, true)
    ]);
    setSessions(active);
    setArchivedSessions(archived);
  }

  async function archiveSessionById(id: string) {
    try {
      if (currentSessionId === id) {
        startNewSession();
      }
      await archiveSession(id);
      await refreshSessions();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function unarchiveSessionById(id: string) {
    try {
      await unarchiveSession(id);
      await refreshSessions();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function deleteSessionById(id: string) {
    if (!window.confirm("确认永久删除该对话？此操作不可恢复。")) {
      return;
    }
    try {
      if (currentSessionId === id) {
        startNewSession();
      }
      await deleteSession(id);
      await refreshSessions();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function loadSession(id: string) {
    if (isLoadingSession) {
      return;
    }
    setIsLoadingSession(true);
    setError(null);
    try {
      const detail = await fetchSession(id);
      setCurrentSessionId(detail.id);
      setActiveSession(detail);
      // 防御性去重：历史版本可能把同一消息以不同 id 反复持久化
      // （agentRuntime.normalizeMessages 曾为历史消息重新生成 id）
      const seenIds = new Set<string>();
      const dedupedMessages = detail.messages.filter((message) => {
        if (seenIds.has(message.id)) {
          return false;
        }
        seenIds.add(message.id);
        return true;
      });
      setMessages(dedupedMessages.length ? dedupedMessages : seedMessages);
      setLastRun(detail.runs.at(-1) ?? null);
      setStreamAudit(detail.audit);
      setStreamArtifacts(detail.artifacts);
      setStreamToolInvocations(detail.toolInvocations);
      setActivePanel(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setIsLoadingSession(false);
    }
  }

  const transcriptRef = useRef<HTMLDivElement | null>(null);

  // 打开/切换对话后自动滚动到最新消息（底部）。
  // 用 useLayoutEffect：在浏览器绘制前同步设置滚动位置，
  // 避免「先显示头部再跳到底部」的可见闪烁。
  useLayoutEffect(() => {
    const element = transcriptRef.current;
    if (element) {
      element.scrollTop = element.scrollHeight;
    }
  }, [messages, activeToolInvocations, activeSession]);

  function startNewSession() {
    setCurrentSessionId(crypto.randomUUID());
    setActiveSession(null);
    setLastRun(null);
    setMessages(seedMessages);
    setStreamAudit([]);
    setStreamArtifacts([]);
    setStreamToolInvocations([]);
    setMcpResult(null);
    setActivePanel(null);
  }

  function applyWorkspaceHeight(height: number) {
    const element = workspaceStackRef.current;
    if (element) {
      element.style.height = `${height}px`;
    }
  }

  function setWorkspaceHeightClamped(nextHeight: number) {
    const clamped = clampWorkspaceHeight(nextHeight);
    workspaceHeightRef.current = clamped;
    setWorkspaceHeight(clamped);
  }

  function handleWorkspaceResizeStart(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    workspaceResizeStart.current = {
      pointerId: event.pointerId,
      y: event.clientY,
      height: workspaceHeightRef.current
    };
    setIsResizingWorkspace(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleWorkspaceResizeMove(event: ReactPointerEvent<HTMLDivElement>) {
    const start = workspaceResizeStart.current;
    if (!start || start.pointerId !== event.pointerId) {
      return;
    }
    const nextHeight = clampWorkspaceHeight(start.height + start.y - event.clientY);
    workspaceHeightRef.current = nextHeight;
    applyWorkspaceHeight(nextHeight);
  }

  function handleWorkspaceResizeEnd(event: ReactPointerEvent<HTMLDivElement>) {
    const start = workspaceResizeStart.current;
    if (!start || start.pointerId !== event.pointerId) {
      return;
    }
    workspaceResizeStart.current = null;
    setIsResizingWorkspace(false);
    setWorkspaceHeight(workspaceHeightRef.current);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function handleWorkspaceResizeKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }
    const step = event.shiftKey ? WORKSPACE_KEYBOARD_FAST_STEP : WORKSPACE_KEYBOARD_STEP;
    switch (event.key) {
      case "ArrowUp":
      case "ArrowRight":
        event.preventDefault();
        setWorkspaceHeightClamped(workspaceHeightRef.current + step);
        break;
      case "ArrowDown":
      case "ArrowLeft":
        event.preventDefault();
        setWorkspaceHeightClamped(workspaceHeightRef.current - step);
        break;
      case "Home":
        event.preventDefault();
        setWorkspaceHeightClamped(WORKSPACE_MIN_HEIGHT);
        break;
      case "End":
        event.preventDefault();
        setWorkspaceHeightClamped(workspaceMaxHeight());
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        resetWorkspaceHeight();
        break;
    }
  }

  function resetWorkspaceHeight() {
    const reset = defaultWorkspaceHeight();
    setWorkspaceHeightClamped(reset);
    applyWorkspaceHeight(reset);
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
    setActiveSession(null);
    setStreamAudit([]);
    setStreamArtifacts([]);
    setStreamToolInvocations([]);
    setPrompt("");
    try {
      const run = await streamAgent({
        messages: nextMessages.map((message) => ({
          role: message.role,
          content: message.content,
          ...(message.id ? { id: message.id } : {}),
          ...(message.createdAt ? { createdAt: message.createdAt } : {})
        })),
        sessionId: currentSessionId,
        enabledTools: enabledToolList,
        permissionMode: effectivePermissionMode
      }, applyRunEvent);
      setCurrentSessionId(run.sessionId ?? currentSessionId);
      setLastRun(run);
      setMessages(run.messages);
      setStreamAudit(run.audit);
      setStreamArtifacts(run.artifacts);
      setStreamToolInvocations(run.toolInvocations);
      await refreshApprovals();
      await refreshPersistedAudit();
      await refreshSessions();
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
      const result = await callMcpTool(name, args, effectivePermissionMode, currentSessionId);
      setMcpResult(result);
      await refreshApprovals();
      await refreshSessions();
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

async function handleGenerateReport() {
    if (!reportTitle.trim() || isGeneratingReport) return;
    setIsGeneratingReport(true);
    setError(null);
    try {
      const request: GenerateReportRequest = {
        sessionId: currentSessionId,
        reportTitle: reportTitle.trim(),
        severity: reportSeverity,
        toolInvocations: activeToolInvocations,
        artifacts: activeArtifacts,
        messages
      };
      const result = await generateReport(request);
      setGeneratedReport(result.invocation.result?.report ?? null);
      setReportDialogOpen(false);
      setActivePanel("dashboard");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setIsGeneratingReport(false);
    }
  }

  async function handleExportReport(fmt: "markdown" | "json") {
    if (!generatedReport || isGeneratingReport) return;
    setIsGeneratingReport(true);
    setError(null);
    try {
      const request: ExportReportRequest = {
        sessionId: currentSessionId,
        format: fmt,
        reportData: generatedReport
      };
      const result = await exportReport(request);
      const exportContent = result.invocation.result?.content ?? "";
      setExportedContent(exportContent);
      setExportFormat(fmt);
      const ext = fmt === "markdown" ? ".md" : ".json";
      const mimeType = fmt === "markdown" ? "text/markdown" : "application/json";
      const blob = new Blob([exportContent], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `incident-report-${currentSessionId.slice(0, 8)}${ext}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setIsGeneratingReport(false);
    }
  }

  async function copyToClipboard(text: string, id: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      // fallback
    }
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
    void refreshSessions();
  }

  // 工作区按键：点击总是打开/切换到对应面板，不再二次点击关闭；
  // 返回对话界面统一通过顶部「返回对话」按钮。
  function openPanel(panel: WorkbenchPanel) {
    setActivePanel(panel);
    if (panel !== "archived" && panel !== "plugins" && panel !== "skills" && panel !== "tools" && panel !== "dashboard" && panel !== "knowledge-graph" && panel !== "model-config") {
      setTab(panel);
    }
  }

  async function refreshHealth() {
    try {
      setHealth(await fetchHealth());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function applyMcpServerState(state: McpServerConfigState) {
    setMcpServers(state);
    const [nextTools, nextMcpTools] = await Promise.all([
      fetchTools(),
      fetchMcpTools()
    ]);
    setTools(nextTools);
    setMcpTools(nextMcpTools);
    setEnabledTools((current) => reconcileEnabledTools(current, tools, nextTools));
  }

  async function refreshToolsAfterReload() {
    const [nextTools, nextMcpTools] = await Promise.all([
      fetchTools(),
      fetchMcpTools()
    ]);
    setTools(nextTools);
    setMcpTools(nextMcpTools);
    setEnabledTools((current) => reconcileEnabledTools(current, tools, nextTools));
  }

  async function reloadPluginState(): Promise<PluginSummary[]> {
    const state = await reloadPlugins();
    setPlugins(state);
    setSkills(await fetchSkills());
    setMcpServers(await fetchMcpServers());
    await refreshToolsAfterReload();
    return state;
  }

  async function reloadSkillState(): Promise<SkillSummary[]> {
    const state = await reloadSkills();
    setSkills(state);
    setPlugins(await fetchPlugins());
    await refreshToolsAfterReload();
    return state;
  }

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="SecOps workspace">
        <div className="brand-row">
          <div className="brand-mark">
            <Bot size={22} aria-hidden="true" />
          </div>
          <div>
            <h1>SecOps Agent</h1>
            <p>安全工作区</p>
          </div>
        </div>

        <div className="conversation-list" aria-label="会话列表">
          <div className="section-label">
            <MessageSquare size={14} aria-hidden="true" />
            <span>会话</span>
          </div>
          <button
            className={!activePanel && !activeSession ? "new-chat-btn active" : "new-chat-btn"}
            onClick={startNewSession}
            type="button"
          >
            <Plus size={15} aria-hidden="true" />
            <span>新建对话</span>
          </button>
          {liveConversationActive ? (
            <button
              className="session-row active"
              onClick={() => undefined}
              title="当前对话（未保存，发生对话后显示）"
              type="button"
            >
              <strong>{liveSessionTitle(messages)}</strong>
              <small>{messages.length} 条消息 · {activeToolInvocations.length} 次工具调用</small>
            </button>
          ) : null}
          {sessions.length ? sessions.map((session) => (
            <div
              className={currentSessionId === session.id && activeSession ? "session-row active" : "session-row"}
              key={session.id}
            >
              <button
                className="session-open"
                disabled={isLoadingSession}
                onClick={() => loadSession(session.id)}
                type="button"
              >
                <strong>{sessionTitle(session)}</strong>
                <small>
                  {session.messageCount} 条消息 · {session.toolInvocationCount} 次工具调用
                  {session.guidanceCount ? ` · ${session.guidanceCount} 引导` : ""}
                </small>
              </button>
              <div className="session-actions">
                <button onClick={() => void archiveSessionById(session.id)} title="归档" type="button">
                  <Archive size={13} aria-hidden="true" />
                </button>
                <button className="danger" onClick={() => void deleteSessionById(session.id)} title="删除" type="button">
                  <Trash2 size={13} aria-hidden="true" />
                </button>
              </div>
            </div>
          )) : (
            <p className="sidebar-empty">暂无保存的会话</p>
          )}
        </div>

        <div
          aria-controls="workspace-nav-stack"
          aria-label="调整工作区高度"
          aria-orientation="horizontal"
          aria-valuemax={workspaceMaxHeight()}
          aria-valuemin={WORKSPACE_MIN_HEIGHT}
          aria-valuenow={workspaceHeight}
          aria-valuetext={`${workspaceHeight} 像素`}
          className={isResizingWorkspace ? "sidebar-divider resizing" : "sidebar-divider"}
          onDoubleClick={resetWorkspaceHeight}
          onKeyDown={handleWorkspaceResizeKeyDown}
          onPointerCancel={handleWorkspaceResizeEnd}
          onPointerDown={handleWorkspaceResizeStart}
          onPointerMove={handleWorkspaceResizeMove}
          onPointerUp={handleWorkspaceResizeEnd}
          role="separator"
          tabIndex={0}
          title="拖动调整工作区高度，方向键微调，双击恢复默认"
        />

        <div
          aria-label="工作区工具"
          className={isResizingWorkspace ? "nav-stack resizing" : "nav-stack"}
          id="workspace-nav-stack"
          ref={workspaceStackRef}
          style={{ height: workspaceHeight }}
        >
          <div className="section-label">
            <Settings2 size={14} aria-hidden="true" />
            <span>工作区</span>
          </div>
<button
            className={activePanel === "dashboard" ? "nav-item active" : "nav-item"}
            onClick={() => openPanel("dashboard")}
            type="button"
          >
            <LayoutDashboard size={15} aria-hidden="true" />
            <span>仪表盘</span>
            <strong>{sessions.length}</strong>
          </button>
          <button
            className={activePanel === "archived" ? "nav-item active" : "nav-item"}
            onClick={() => openPanel("archived")}
            type="button"
          >
            <Archive size={15} aria-hidden="true" />
            <span>归档</span>
            <strong>{archivedSessions.length}</strong>
          </button>
          <button
            className={activePanel === "model-config" ? "nav-item active" : "nav-item"}
            onClick={() => openPanel("model-config")}
            type="button"
          >
            <Server size={15} aria-hidden="true" />
            <span>模型配置</span>
            <strong>{health?.configured ? "已配置" : "未配置"}</strong>
          </button>
          <button
            className={activePanel === "knowledge-graph" ? "nav-item active" : "nav-item"}
            onClick={() => openPanel("knowledge-graph")}
            type="button"
          >
            <Network size={15} aria-hidden="true" />
            <span>知识图谱</span>
            <strong>{Math.min(tools.length, 10) + Math.min(sessions.length, 5) + 7 + (activeSession?.artifacts?.length ?? streamArtifacts.length)}</strong>
          </button>
          <button
            className={activePanel === "plugins" ? "nav-item active" : "nav-item"}
            onClick={() => openPanel("plugins")}
            type="button"
          >
            <PlugZap size={15} aria-hidden="true" />
            <span>插件</span>
            <strong>{plugins.length}</strong>
          </button>
          <button
            className={activePanel === "skills" ? "nav-item active" : "nav-item"}
            onClick={() => openPanel("skills")}
            type="button"
          >
            <Sparkles size={15} aria-hidden="true" />
            <span>技能</span>
            <strong>{skills.filter((skill) => skill.status === "loaded").length}</strong>
          </button>
          <button
            className={activePanel === "tools" ? "nav-item active" : "nav-item"}
            onClick={() => openPanel("tools")}
            type="button"
          >
            <Wrench size={15} aria-hidden="true" />
            <span>工具</span>
            <strong>{enabledToolCount}/{tools.length}</strong>
          </button>
          <button
            className={activePanel === "plan" ? "nav-item active" : "nav-item"}
            onClick={() => openPanel("plan")}
            type="button"
          >
            <Activity size={15} aria-hidden="true" />
            <span>活动</span>
            <strong>{activeToolInvocations.length}</strong>
          </button>
          <button
            className={activePanel === "audit" ? "nav-item active" : "nav-item"}
            onClick={() => openPanel("audit")}
            type="button"
          >
            <ShieldCheck size={15} aria-hidden="true" />
            <span>审计追踪</span>
            <strong>{visibleAudit.length}</strong>
          </button>
          <button
            className={activePanel === "artifacts" ? "nav-item active" : "nav-item"}
            onClick={() => openPanel("artifacts")}
            type="button"
          >
            <DatabaseZap size={15} aria-hidden="true" />
            <span>证据</span>
            <strong>{activeArtifacts.length}</strong>
          </button>
        </div>

        <div className="provider-card">
          <div className="section-label">
            <Settings2 size={14} aria-hidden="true" />
            <span>运行时</span>
          </div>
          <strong>{health?.model ?? "加载中"}</strong>
          <div className="runtime-grid">
            <span>{health?.provider ?? "供应商"}</span>
            <span>{health?.configured ? "已配置" : "需要配置"}</span>
            <span>{health?.capabilities.tools ? "工具已开启" : "工具已关闭"}</span>
            <span>{health?.actionLevel ?? "沙箱"}</span>
            <span>{health?.durableSessionStore.configured ? "数据库会话" : "本地会话"}</span>
          </div>
        </div>
      </aside>

      <main className={activePanel ? "main-panel config-mode" : "main-panel"}>
        {activePanel ? (
          <section className="config-workspace" aria-label={`${panelTitle(activePanel)} workspace`}>
            <header className="config-topbar">
              <button className="back-button" onClick={() => setActivePanel(null)} type="button">
                <MessageSquare size={16} aria-hidden="true" />
                <span>返回对话</span>
              </button>
              <div>
                <h2>{panelTitle(activePanel)}</h2>
                {panelSubtitle(activePanel, {
                  activeArtifacts,
                  activeToolInvocations,
                  enabledMcpCount,
                  enabledToolCount,
                  mcpTools,
                  pendingApprovals,
                  tools,
                  visibleAudit
                }) ? (
                  <p>{panelSubtitle(activePanel, {
                    activeArtifacts,
                    activeToolInvocations,
                    enabledMcpCount,
                    enabledToolCount,
                    mcpTools,
                    pendingApprovals,
                    tools,
                    visibleAudit
                  })}</p>
                ) : null}
              </div>
              {activePanel !== "tools" ? (
                <div className={`approval-dot ${pendingApprovals.length ? "active" : ""}`} title="待审批">
                  {pendingApprovals.length}
                </div>
              ) : null}
            </header>

{activePanel === "dashboard" ? (
              <div className="config-inspector">
                <DashboardView
                  generatedReport={generatedReport}
                  isGeneratingReport={isGeneratingReport}
                  messages={messages}
                  onExportReport={handleExportReport}
                  onOpenReportDialog={() => {
                    setReportTitle("");
                    setReportSeverity("medium");
                    setReportDialogOpen(true);
                  }}
                  sessions={sessions}
                  skills={skills}
                  toolInvocations={activeToolInvocations}
                  tools={tools}
                />
              </div>
            ) : activePanel === "archived" ? (
              <div className="config-inspector">
                <ArchivedSessionsView
                  archivedSessions={archivedSessions}
                  onDelete={(id) => void deleteSessionById(id)}
                  onRestore={(id) => void unarchiveSessionById(id)}
                />
              </div>
            ) : activePanel === "knowledge-graph" ? (
              <KnowledgeGraphView
                tools={tools}
                mcpTools={mcpTools}
                sessions={sessions}
                activeSession={activeSession}
                streamArtifacts={streamArtifacts}
                streamToolInvocations={streamToolInvocations}
                health={health}
              />
            ) : activePanel === "model-config" ? (
              <ModelConfigView onConfigChanged={refreshHealth} />
            ) : activePanel === "plugins" ? (
              <PluginView onReload={reloadPluginState} plugins={plugins} />
            ) : activePanel === "skills" ? (
              <SkillView onReload={reloadSkillState} skills={skills} />
            ) : activePanel === "tools" ? (
              <div className="tool-workspace">
                <div className="tool-workspace-tabs" role="tablist" aria-label="工具工作区视图">
                  <button aria-selected={toolWorkspaceTab === "scope"} className={toolWorkspaceTab === "scope" ? "active" : ""} onClick={() => setToolWorkspaceTab("scope")} role="tab" type="button">
                    <Wrench size={15} aria-hidden="true" />
                    <span>工具范围</span>
                  </button>
                  <button aria-selected={toolWorkspaceTab === "mcp"} className={toolWorkspaceTab === "mcp" ? "active" : ""} onClick={() => setToolWorkspaceTab("mcp")} role="tab" type="button">
                    <PlugZap size={15} aria-hidden="true" />
                    <span>MCP 服务</span>
                    <strong>{mcpServers.servers.length}</strong>
                  </button>
                </div>
                {toolWorkspaceTab === "scope" ? (
                  <div className="config-grid skills-config">
                <section className="config-section wide">
                  <div className="section-label">
                    <Wrench size={14} aria-hidden="true" />
                    <span>运行范围</span>
                  </div>
                  <div className="scope-actions config-actions" aria-label="运行范围控制">
                    <button disabled={fullAccessActive} onClick={enableVisibleTools} type="button">
                      <Wrench size={15} aria-hidden="true" />
                      <span>启用可见</span>
                    </button>
                    <button disabled={fullAccessActive} onClick={disableVisibleTools} type="button">
                      <XCircle size={15} aria-hidden="true" />
                      <span>禁用可见</span>
                    </button>
                    <button disabled={fullAccessActive} onClick={useReadOnlyScope} type="button">
                      <ShieldCheck size={15} aria-hidden="true" />
                      <span>只读</span>
                    </button>
                    <button disabled={fullAccessActive} onClick={disableActionTools} type="button">
                      <LockKeyhole size={15} aria-hidden="true" />
                      <span>关闭操作</span>
                    </button>
                  </div>
                  <div className="section-label">
                    <Search size={14} aria-hidden="true" />
                    <span>搜索工具</span>
                  </div>
                  <input
                    aria-label="筛选工具"
                    className="tool-search"
                    onChange={(event) => setToolQuery(event.target.value)}
                    placeholder="筛选工具..."
                    type="search"
                    value={toolQuery}
                  />
                  <div className="tool-filters" aria-label="工具类别筛选">
                    {toolClassFilters.map((filter) => (
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

                <section className="config-section wide">
                  <div className="section-label">
                    <Wrench size={14} aria-hidden="true" />
                    <span>工具</span>
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
                          <span className="tool-badges">
                            <em>{tool.toolClass}</em>
                            <em className={`risk-${tool.risk}`}>{tool.risk}</em>
                            {tool.mcpCompatible ? <em>MCP</em> : null}
                          </span>
                        </span>
                      </label>
                    )) : <p className="empty-state">没有匹配的工具</p>}
                  </div>
                </section>
                  </div>
                ) : (
                  <div className="mcp-workspace">
                    <McpServerConfigView onChanged={applyMcpServerState} state={mcpServers} />
                    <section className="config-section wide mcp-call-console">
                      <McpView
                        isRunning={isMcpRunning}
                        mcpResult={mcpResult}
                        mcpTools={mcpTools}
                        onCall={callMcp}
                        onResolveApproval={resolveApproval}
                        permissionMode={effectivePermissionMode}
                        resolvingApprovalId={resolvingApprovalId}
                      />
                    </section>
                  </div>
                )}
              </div>
            ) : (
              <div className="config-inspector">
                <div className="inspector-tabs config-tabs" role="tablist" aria-label="检查器视图">
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
                    <span>活动</span>
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
                    <span>审计</span>
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
                    <span>证据</span>
                  </button>
                </div>
                {tab === "plan" ? (
<div aria-labelledby="tab-activity" id="panel-activity" role="tabpanel">
                    <div className="report-actions">
                      <button
                        className="report-generate-btn"
                        disabled={isGeneratingReport}
                        onClick={() => {
                          setReportTitle("");
                          setReportSeverity("medium");
                          setReportDialogOpen(true);
                        }}
                        type="button"
                      >
                        <FileText size={15} aria-hidden="true" />
                        <span>生成报告</span>
                      </button>
                    </div>
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
                    <div className="report-actions">
                      <button
                        className="report-generate-btn"
                        disabled={isGeneratingReport}
                        onClick={() => {
                          setReportTitle("");
                          setReportSeverity("medium");
                          setReportDialogOpen(true);
                        }}
                        type="button"
                      >
                        <FileText size={15} aria-hidden="true" />
                        <span>生成报告</span>
                      </button>
                    </div>
                    <EnhancedArtifactView
                      artifacts={activeArtifacts}
                      copiedId={copiedId}
                      onCopy={copyToClipboard}
                    />
                    {activeArtifacts.length > 0 ? <MitreMatrix artifacts={activeArtifacts} toolInvocations={activeToolInvocations} /> : null}
                  </div>
                ) : null}
              </div>
            )}
          </section>
        ) : (
          <>
        <header className="topbar">
          <div>
            <h2>安全运营控制台</h2>
            <p>{enabledToolCount} 个工具已启用 · {enabledMcpCount} 个 MCP 工具 · {health?.actionLevel ?? "沙箱"} 访问</p>
          </div>
          <div className="topbar-actions">
            <div className="segmented" aria-label="权限模式">
              {(["auto", "ask", "deny"] as PermissionMode[]).map((mode) => (
                <button
                  aria-pressed={effectivePermissionMode === mode}
                  className={effectivePermissionMode === mode ? "active" : ""}
                  disabled={fullAccessActive}
                  key={mode}
                  onClick={() => setPermissionMode(mode)}
                  type="button"
                >
                  {mode === "auto" ? "自动" : mode === "ask" ? "询问" : "拒绝"}
                </button>
              ))}
            </div>
            <div className="segmented access-level" aria-label="自动化访问级别">
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
              title="运行当前提示"
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

        <section className="chat-stage" aria-label="智能体对话">
          <div className="transcript" aria-label="对话记录" ref={transcriptRef}>
              {messages.filter((message) => message.role !== "tool").map((message) => (
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
            <span>{health?.provider ?? "供应商"} · {health?.model ?? "model"}</span>
          </div>
          <textarea
            aria-label="智能体提示"
            aria-keyshortcuts="Enter"
            onKeyDown={handlePromptKeyDown}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="输入安全调查指令..."
            rows={3}
            value={prompt}
          />
          <button className="send-button" disabled={isRunning || !prompt.trim()} id="composer-submit" type="submit">
            {isRunning ? <Loader2 className="spin" size={18} aria-hidden="true" /> : <Send size={18} aria-hidden="true" />}
            <span>运行</span>
          </button>
        </form>
          </>
        )}
      </main>

{reportDialogOpen ? (
        <div className="report-overlay" onClick={() => setReportDialogOpen(false)}>
          <div className="report-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>生成事件报告</h3>
            <label className="report-field">
              <span>报告标题</span>
              <input
                onChange={(e) => setReportTitle(e.target.value)}
                placeholder="例如：可疑登录调查"
                type="text"
                value={reportTitle}
              />
            </label>
            <label className="report-field">
              <span>严重级别</span>
              <select
                onChange={(e) => setReportSeverity(e.target.value as "low" | "medium" | "high" | "critical")}
                value={reportSeverity}
              >
                <option value="low">低</option>
                <option value="medium">中</option>
                <option value="high">高</option>
                <option value="critical">严重</option>
              </select>
            </label>
            <div className="report-summary">
              <p>会话: {currentSessionId.slice(0, 8)}...</p>
              <p>{activeToolInvocations.length} 次工具调用 - {activeArtifacts.length} 个工件</p>
            </div>
            <div className="report-dialog-actions">
              <button className="cancel-btn" onClick={() => setReportDialogOpen(false)} type="button">
                取消
              </button>
              <button
                className="generate-btn"
                disabled={isGeneratingReport || !reportTitle.trim()}
                onClick={handleGenerateReport}
                type="button"
              >
                {isGeneratingReport ? <Loader2 className="spin" size={15} aria-hidden="true" /> : <FileText size={15} aria-hidden="true" />}
                <span>生成</span>
              </button>
            </div>
          </div>
        </div>
      ) : null}

    </div>
  );
}

function StatusPill({ health }: { health: ProviderStatus | null }) {
  const healthy = Boolean(health?.configured);
  return (
    <div className={`status-pill ${healthy ? "ok" : "warn"}`}>
      {healthy ? <CheckCircle2 size={15} aria-hidden="true" /> : <AlertTriangle size={15} aria-hidden="true" />}
      <span>{healthy ? "已配置" : "需要配置"}</span>
    </div>
  );
}

function panelTitle(panel: WorkbenchPanel): string {
  if (panel === "dashboard") {
    return "仪表盘";
  }
  if (panel === "archived") {
    return "归档对话";
  }
  if (panel === "knowledge-graph") {
    return "知识图谱";
  }
  if (panel === "model-config") {
    return "模型配置";
  }
  if (panel === "plugins") {
    return "插件";
  }
  if (panel === "skills") {
    return "技能";
  }
  if (panel === "tools") {
    return "工具";
  }
  if (panel === "audit") {
    return "审计追踪";
  }
  if (panel === "artifacts") {
    return "证据";
  }
  return "运行活动";
}

function panelSubtitle(
  panel: WorkbenchPanel,
  context: {
    activeArtifacts: EvidenceArtifact[];
    activeToolInvocations: ToolInvocation[];
    enabledMcpCount: number;
    enabledToolCount: number;
    mcpTools: McpToolSummary[];
    pendingApprovals: PendingApproval[];
    tools: ToolManifest[];
    visibleAudit: AuditEvent[];
  }
): string {
  if (panel === "dashboard") {
    return "概览";
  }
  if (panel === "archived") {
    return "已归档对话，可恢复或删除";
  }
  if (panel === "knowledge-graph") {
    return "";
  }
  if (panel === "model-config") {
    return "启动前编辑 runtime/config/model.json 读取 · 启动后界面 CRUD 或从文件重载，均无需重启";
  }
  if (panel === "plugins") {
    return "插件安装状态与插件 MCP 连接";
  }
  if (panel === "skills") {
    return "技能目录、来源与正文";
  }
  if (panel === "tools") {
    return `${context.enabledToolCount}/${context.tools.length} 已启用 · ${context.enabledMcpCount} 个 MCP 工具`;
  }
  if (panel === "audit") {
    return `${context.visibleAudit.length} 条审计事件`;
  }
  if (panel === "artifacts") {
    return `${context.activeArtifacts.length} 个证据工件`;
  }
  return `${context.activeToolInvocations.length} 次工具调用 · ${context.pendingApprovals.length} 个待审批`;
}

function ArchivedSessionsView({
  archivedSessions,
  onRestore,
  onDelete
}: {
  archivedSessions: AgentSessionSummary[];
  onRestore: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <section className="config-section wide archived-session-section">
      <div className="section-label">
        <ArchiveRestore size={14} aria-hidden="true" />
        <span>归档对话</span>
      </div>
      {archivedSessions.length ? archivedSessions.map((session) => (
        <div className="archived-session-row" key={session.id}>
          <div className="archived-session-copy">
            <strong>{sessionTitle(session)}</strong>
            <small>
              {session.messageCount} 条消息 · {session.toolInvocationCount} 次工具调用
              {session.guidanceCount ? ` · ${session.guidanceCount} 引导` : ""}
            </small>
          </div>
          <div className="archived-session-actions">
            <button onClick={() => onRestore(session.id)} title="恢复对话" type="button">
              <ArchiveRestore size={14} aria-hidden="true" />
              <span>恢复</span>
            </button>
            <button className="danger" onClick={() => onDelete(session.id)} title="删除对话" type="button">
              <Trash2 size={14} aria-hidden="true" />
              <span>删除</span>
            </button>
          </div>
        </div>
      )) : <p className="empty-state">暂无归档对话</p>}
    </section>
  );
}

function renderMarkdown(text: string): string {
  // Split into lines for line-level processing
  const lines = text.split("\n");
  const result: string[] = [];
  let inTable = false;
  let tableRows: string[] = [];
  let inList = false;
  let listItems: string[] = [];

  function flushList() {
    if (listItems.length > 0) {
      result.push(`<ul>${listItems.map((li) => `<li>${li}</li>`).join("")}</ul>`);
      listItems = [];
    }
    inList = false;
  }

  function flushTable() {
    if (tableRows.length > 0) {
      const headerRow = tableRows[0]!;
      const bodyRows = tableRows.slice(1);
      const headerCells = headerRow.split("|").filter(Boolean).map((cell) => cell.trim());
      const headerHtml = `<thead><tr>${headerCells.map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join("")}</tr></thead>`;
      const bodyHtml = bodyRows.length > 0
        ? `<tbody>${bodyRows.map((row) => {
            const cells = row.split("|").filter(Boolean).map((cell) => cell.trim());
            return `<tr>${cells.map((cell) => `<td>${inlineMarkdown(cell)}</td>`).join("")}</tr>`;
          }).join("")}</tbody>`
        : "";
      // Skip separator row (|---|---|)
      if (bodyRows.length > 0 && bodyRows[0] && !bodyRows[0].match(/^[\s|:\-]+$/)) {
        result.push(`<table>${headerHtml}${bodyHtml}</table>`);
      } else if (bodyRows.length > 1) {
        result.push(`<table>${headerHtml}<tbody>${bodyRows.slice(1).map((row) => {
          const cells = row.split("|").filter(Boolean).map((cell) => cell.trim());
          return `<tr>${cells.map((cell) => `<td>${inlineMarkdown(cell)}</td>`).join("")}</tr>`;
        }).join("")}</tbody></table>`);
      }
      tableRows = [];
    }
    inTable = false;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();

    // Empty line: flush lists and tables
    if (trimmed === "") {
      flushList();
      flushTable();
      result.push("");
      continue;
    }

    // Table detection
    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      if (!inTable) {
        flushList();
        inTable = true;
      }
      tableRows.push(trimmed);
      continue;
    } else if (inTable) {
      flushTable();
    }

    // Unordered list
    if (trimmed.match(/^[\-\*]\s/)) {
      if (!inList) {
        flushTable();
        inList = true;
      }
      listItems.push(inlineMarkdown(trimmed.replace(/^[\-\*]\s+/, "")));
      continue;
    } else if (inList) {
      flushList();
    }

    // Headings
    if (trimmed.startsWith("### ")) {
      result.push(`<h3>${inlineMarkdown(trimmed.slice(4))}</h3>`);
      continue;
    }
    if (trimmed.startsWith("## ")) {
      result.push(`<h2>${inlineMarkdown(trimmed.slice(3))}</h2>`);
      continue;
    }
    if (trimmed.startsWith("# ")) {
      result.push(`<h1>${inlineMarkdown(trimmed.slice(2))}</h1>`);
      continue;
    }

    // Horizontal rule
    if (trimmed.match(/^[\-\*\_]{3,}$/)) {
      result.push("<hr>");
      continue;
    }

    // Regular paragraph
    result.push(`<p>${inlineMarkdown(trimmed)}</p>`);
  }

  flushList();
  flushTable();

  return result.join("\n");
}

function inlineMarkdown(text: string): string {
  // Bold: **text** or __text__
  text = text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/__(.+?)__/g, "<strong>$1</strong>");
  // Italic: *text* or _text_
  text = text.replace(/\*(.+?)\*/g, "<em>$1</em>");
  text = text.replace(/_(.+?)_/g, "<em>$1</em>");
  // Inline code: `text`
  text = text.replace(/`(.+?)`/g, "<code>$1</code>");
  return text;
}

function TranscriptMessage({ message }: { message: ChatMessage }) {
  const isTool = message.role === "tool";
  const [toolExpanded, setToolExpanded] = useState(false);

  if (isTool) {
    return (
      <article className="message tool collapsed-message">
        <div className="avatar">TL</div>
        <div className="message-body">
          <button
            className="tool-message-toggle"
            onClick={() => setToolExpanded((prev) => !prev)}
            type="button"
            title={toolExpanded ? "收起" : "展开"}
          >
            {toolExpanded ? <ChevronDown size={11} aria-hidden="true" /> : <ChevronRight size={11} aria-hidden="true" />}
            <strong>{message.name ?? "工具"}</strong>
            <time>{new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
            <span className="tool-msg-hint">{toolExpanded ? "收起" : "详情"}</span>
          </button>
          {toolExpanded ? (
            <div className="tool-message-content" dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }} />
          ) : null}
        </div>
      </article>
    );
  }

  return (
    <article className={`message ${message.role}`}>
      <div className="avatar">{message.role === "user" ? "AN" : "AG"}</div>
      <div className="message-body">
        <div className="message-meta">
          <strong>{message.name ?? labelForRole(message.role)}</strong>
          <time>{new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
        </div>
        <div className="message-content" dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }} />
      </div>
    </article>
  );
}

function labelForRole(role: ChatMessage["role"]) {
  if (role === "user") {
    return "分析师";
  }
  if (role === "tool") {
    return "工具";
  }
  return "智能体";
}

function auditEventsFromRunEvents(events: AgentRunEvent[]): AuditEvent[] {
  return events
    .map((event) => event.audit)
    .filter((event): event is AuditEvent => Boolean(event));
}

function defaultEnabledToolIds(tools: ToolManifest[]): string[] {
  return tools
    .filter((tool) => tool.risk !== "high")
    .map((tool) => tool.id);
}

export function reconcileEnabledTools(
  current: ReadonlySet<string>,
  previousTools: ToolManifest[],
  nextTools: ToolManifest[]
): Set<string> {
  const previousIds = new Set(previousTools.map((tool) => tool.id));
  const nextIds = new Set(nextTools.map((tool) => tool.id));
  const newDefaults = defaultEnabledToolIds(nextTools).filter((id) => !previousIds.has(id));
  return new Set([
    ...[...current].filter((id) => nextIds.has(id)),
    ...newDefaults
  ]);
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

function liveSessionTitle(messages: ChatMessage[]): string {
  const firstUser = messages.find((message) => message.role === "user");
  if (firstUser && typeof firstUser.content === "string" && firstUser.content.trim()) {
    const text = firstUser.content.trim();
    return text.length > 24 ? `${text.slice(0, 24)}…` : text;
  }
  return "新对话";
}

function sessionTitle(session: AgentSessionSummary): string {
  const latest = session.latestMessage?.content.trim();
  return latest ? compact(latest) : `会话 ${session.id.slice(0, 8)}`;
}

function CollapsibleJson({
  data,
  maxPreviewLength = 120,
  defaultOpen = false
}: {
  data: unknown;
  maxPreviewLength?: number;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const raw = JSON.stringify(data, null, 2);

  return (
    <div className="collapsible-json">
      <button
        className="collapsible-json-toggle"
        onClick={() => setOpen((prev) => !prev)}
        type="button"
        title={open ? "折叠" : "展开"}
      >
        {open ? <ChevronDown size={11} aria-hidden="true" /> : <ChevronRight size={11} aria-hidden="true" />}
        <span>{open ? "收起" : "详情"}</span>
      </button>
      {open ? <pre>{raw}</pre> : null}
    </div>
  );
}

export function ToolCallCard({
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
  const guidance = invocation.guidance;
  const executed = !guidance && !pending;
  return (
    <div className={`tool-call ${guidance ? "guidance" : pending ? "pending" : invocation.status}`} key={invocation.id}>
      {executed ? null : (
        <div className="tool-call-icon">
          {guidance ? <AlertTriangle size={16} aria-hidden="true" /> : <LockKeyhole size={16} aria-hidden="true" />}
        </div>
      )}
      <div>
        <div className="tool-call-title">
          <strong>{invocation.displayName}</strong>
          {executed ? null : <span>{guidance ? "guidance" : invocation.status}</span>}
        </div>
        {pending ? (
          <div className="approval-panel">
            <CollapsibleJson data={invocation.arguments} defaultOpen={true} />
            <div className="approval-actions">
              <button aria-label="Allow" disabled={isResolving} onClick={onApprove} type="button">
                {isResolving ? <Loader2 className="spin" size={15} aria-hidden="true" /> : <CheckCircle2 size={15} aria-hidden="true" />}
                <span>批准</span>
              </button>
              <button aria-label="Deny" className="deny" disabled={isResolving} onClick={onDeny} type="button">
                <XCircle size={15} aria-hidden="true" />
                <span>拒绝</span>
              </button>
            </div>
          </div>
        ) : guidance ? (
          <div className="guidance-panel">
            <div className="tool-call-section">
              <span className="tool-call-section-label">调用参数</span>
              <CollapsibleJson data={invocation.arguments} defaultOpen={true} />
            </div>
            <div className="tool-call-section">
              <span className="tool-call-section-label">返回结果</span>
              <p>{guidance.message}</p>
            </div>
            {guidance.nextTools?.length ? (
              <div className="guidance-next">
                {guidance.nextTools.map((tool) => (
                  <div className="guidance-next-tool" key={`${invocation.id}-${tool.toolName}`}>
                    <strong>{tool.toolName}</strong>
                    <span>{tool.reason}</span>
                    {tool.suggestedArgs ? <CollapsibleJson data={tool.suggestedArgs} /> : null}
                  </div>
                ))}
              </div>
            ) : null}
            {guidance.requiredState?.length ? (
              <div className="guidance-state">
                {guidance.requiredState.map((state) => (
                  <code key={state}>{state}</code>
                ))}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="tool-call-result">
            <div className="tool-call-section">
              <span className="tool-call-section-label">调用参数</span>
              <CollapsibleJson data={invocation.arguments} defaultOpen={true} />
            </div>
            <div className="tool-call-section">
              <span className="tool-call-section-label">返回结果</span>
              <CollapsibleJson data={invocation.result ?? invocation.error} defaultOpen={true} />
            </div>
          </div>
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
      <h3>运行活动</h3>
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
      title: `${labelForRole(message.role)} 消息`,
      detail: compact(message.content),
      kind: "message",
      severity: "info"
    })),
    ...input.toolInvocations.map((invocation): RunActivityItem => ({
      id: `tool-${invocation.id}`,
      at: invocation.completedAt ?? invocation.startedAt,
      title: invocation.displayName,
      detail: invocation.guidance
        ? `引导: ${compact(invocation.guidance.message)}`
        : `${invocation.status}: ${compact(JSON.stringify(invocation.result ?? invocation.error ?? invocation.arguments))}`,
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
      detail: `待审批: ${approval.toolName}`,
      kind: approval.risk,
      severity: "warn"
    }))
  ].sort((left, right) => new Date(right.at).getTime() - new Date(left.at).getTime());
}

function severityForInvocation(invocation: ToolInvocation): ActivitySeverity {
  if (invocation.guidance) {
    return "warn";
  }
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
      <h3>审计追踪</h3>
      <div className="timeline">
        {events.length ? events.map((event) => (
          <div className={`timeline-item ${event.severity}`} key={event.id}>
            <strong>{event.label}</strong>
            <span>{event.detail}</span>
          </div>
        )) : <p className="empty-state">暂无运行记录</p>}
      </div>
    </div>
  );
}

function EnhancedArtifactView({
  artifacts,
  copiedId,
  onCopy
}: {
  artifacts: EvidenceArtifact[];
  copiedId: string | null;
  onCopy: (text: string, id: string) => void;
}) {
  const grouped = useMemo(() => {
    const groups: Record<string, EvidenceArtifact[]> = {};
    for (const a of artifacts) {
      const kind = a.kind ?? "other";
      if (!groups[kind]) groups[kind] = [];
      groups[kind].push(a);
    }
    return groups;
  }, [artifacts]);

  const kindLabels: Record<string, string> = {
    ioc: "IOC",
    detection: "检测",
    asset: "资产",
    case_note: "案件记录"
  };

  return (
    <div className="inspector-body">
      <h3>证据</h3>
      <div className="artifact-type-summary">
        {Object.entries(grouped).map(([kind, items]) => (
          <div className="artifact-type-chip" key={kind}>
            <span className="chip-label">{kindLabels[kind] ?? kind}</span>
            <span className="chip-count">{items.length}</span>
          </div>
        ))}
      </div>
      {artifacts.length ? Object.entries(grouped).map(([kind, items]) => (
        <div key={kind}>
          <div className="section-label">
            <DatabaseZap size={14} aria-hidden="true" />
            <span>{kindLabels[kind] ?? kind} ({items.length})</span>
          </div>
          <div className="artifact-list">
            {items.map((artifact) => (
              <article className="artifact enhanced" key={artifact.id}>
                <div className="artifact-header">
                  <div className="artifact-kind">{artifact.kind}</div>
                  <button
                    className="copy-btn"
                    onClick={() => onCopy(JSON.stringify(artifact.data, null, 2), artifact.id)}
                    title="复制到剪贴板"
                    type="button"
                  >
                    {copiedId === artifact.id ? <CheckCircle2 size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
                  </button>
                </div>
                <strong>{artifact.title}</strong>
                <p>{artifact.summary}</p>
                <CollapsibleJson data={artifact.data} maxPreviewLength={300} />
              </article>
            ))}
          </div>
        </div>
      )) : <p className="empty-state">暂无证据</p>}
    </div>
  );
}

function MitreMatrix({
  artifacts,
  toolInvocations
}: {
  artifacts: EvidenceArtifact[];
  toolInvocations: ToolInvocation[];
}) {
  const allTactics = [
    "Initial Access", "Execution", "Persistence", "Privilege Escalation",
    "Defense Evasion", "Credential Access", "Discovery", "Lateral Movement",
    "Collection", "Command and Control", "Exfiltration", "Impact"
  ];

  const tacticMap: Record<string, string> = {
    "credential-access": "Credential Access",
    "execution": "Execution",
    "command-and-control": "Command and Control",
    "privilege-escalation": "Privilege Escalation",
    "initial-access": "Initial Access",
    "persistence": "Persistence",
    "defense-evasion": "Defense Evasion",
    "discovery": "Discovery",
    "lateral-movement": "Lateral Movement",
    "collection": "Collection",
    "exfiltration": "Exfiltration",
    "impact": "Impact"
  };

  const tactics = useMemo(() => {
    const found = new Set<string>();

    for (const a of artifacts) {
      if (a.kind !== "detection") continue;
      const data = a.data as Record<string, unknown> | undefined;
      const matches = Array.isArray(data?.matches) ? data.matches as Record<string, unknown>[] : [];
      for (const m of matches) {
        const tactic = String(m.tactic ?? "");
        const tacticName = tacticMap[tactic];
        if (tacticName) found.add(tacticName);
      }
    }

    for (const inv of toolInvocations) {
      const result = inv.result as Record<string, unknown> | undefined;
      if (result?.tactic && typeof result.tactic === "string") {
        const tacticName = tacticMap[result.tactic];
        if (tacticName) found.add(tacticName);
      }
    }

    return allTactics.map((t) => ({ name: t, active: found.has(t) }));
  }, [artifacts, toolInvocations]);

  if (tactics.every((t) => !t.active)) return null;

  return (
    <div className="mitre-section">
      <div className="section-label">
        <ShieldCheck size={14} aria-hidden="true" />
        <span>MITRE ATT&amp;CK</span>
      </div>
      <div className="mitre-matrix">
        {tactics.map((tactic) => (
          <div className={`mitre-cell ${tactic.active ? "active" : ""}`} key={tactic.name} title={tactic.name}>
            <span>{tactic.name.slice(0, 3).toUpperCase()}</span>
          </div>
        ))}
      </div>
      <div className="mitre-legend">
        <div className="mitre-legend-item">
          <div className="mitre-legend-dot active" />
          <span>已识别战术</span>
        </div>
        <div className="mitre-legend-item">
          <div className="mitre-legend-dot" />
          <span>未观察到</span>
        </div>
      </div>
    </div>
  );
}

function DashboardView({
  generatedReport,
  isGeneratingReport,
  messages,
  onExportReport,
  onOpenReportDialog,
  sessions,
  skills,
  toolInvocations,
  tools
}: {
  generatedReport: unknown;
  isGeneratingReport: boolean;
  messages: ChatMessage[];
  onExportReport: (fmt: "markdown" | "json") => void;
  onOpenReportDialog: () => void;
  sessions: AgentSessionSummary[];
  skills: SkillSummary[];
  toolInvocations: ToolInvocation[];
  tools: ToolManifest[];
}) {
  const totalToolCalls = toolInvocations.length;
  const lowRisk = toolInvocations.filter((t) => t.risk === "low").length;
  const mediumRisk = toolInvocations.filter((t) => t.risk === "medium").length;
  const highRisk = toolInvocations.filter((t) => t.risk === "high").length;

  const recentActivity = useMemo(() => {
    const items: Array<{ time: string; text: string }> = [];
    for (const t of toolInvocations.slice(-5).reverse()) {
      items.push({
        time: t.completedAt ?? t.startedAt,
        text: `${t.displayName} - ${t.status}`
      });
    }
    for (const m of messages.slice(-3).reverse()) {
      items.push({
        time: m.createdAt,
        text: `${m.role === "user" ? "Analyst" : "Agent"}: ${m.content.slice(0, 80)}`
      });
    }
    return items.slice(0, 10);
  }, [toolInvocations, messages]);

  const report = generatedReport as Record<string, unknown> | null;

  return (
    <div className="inspector-body">
      <h3>仪表盘</h3>

      <div className="dashboard-grid">
        <div className="dashboard-card">
          <div className="dashboard-stat">
            <MessageSquare size={18} aria-hidden="true" />
            <span className="stat-value">{sessions.length}</span>
          </div>
          <span className="stat-label">对话窗口</span>
        </div>
        <div className="dashboard-card">
          <div className="dashboard-stat">
            <Wrench size={18} aria-hidden="true" />
            <span className="stat-value">{tools.length}</span>
          </div>
          <span className="stat-label">工具</span>
        </div>
        <div className="dashboard-card">
          <div className="dashboard-stat">
            <Sparkles size={18} aria-hidden="true" />
            <span className="stat-value">{skills.length}</span>
          </div>
          <span className="stat-label">技能</span>
        </div>
      </div>

      {totalToolCalls > 0 ? (
        <div className="risk-distribution">
          <div className="section-label">
            <BarChart3 size={14} aria-hidden="true" />
            <span>风险分布</span>
          </div>
          <div className="risk-bar">
            <div className="risk-bar-segment low" style={{ width: `${totalToolCalls > 0 ? (lowRisk / totalToolCalls * 100) : 0}%` }} title={`低: ${lowRisk}`}>
              {lowRisk > 0 ? lowRisk : ""}
            </div>
            <div className="risk-bar-segment medium" style={{ width: `${totalToolCalls > 0 ? (mediumRisk / totalToolCalls * 100) : 0}%` }} title={`中: ${mediumRisk}`}>
              {mediumRisk > 0 ? mediumRisk : ""}
            </div>
            <div className="risk-bar-segment high" style={{ width: `${totalToolCalls > 0 ? (highRisk / totalToolCalls * 100) : 0}%` }} title={`高: ${highRisk}`}>
              {highRisk > 0 ? highRisk : ""}
            </div>
          </div>
          <div className="risk-legend">
            <span className="risk-label low">低: {lowRisk}</span>
            <span className="risk-label medium">中: {mediumRisk}</span>
            <span className="risk-label high">高: {highRisk}</span>
          </div>
        </div>
      ) : null}

      {recentActivity.length > 0 ? (
        <div className="recent-activity">
          <div className="section-label">
            <Activity size={14} aria-hidden="true" />
            <span>最近活动</span>
          </div>
          <div className="activity-feed">
            {recentActivity.map((item, i) => (
              <div className="feed-item" key={i}>
                <time>{new Date(item.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
                <span>{item.text}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="report-section">
        <div className="section-label">
          <FileText size={14} aria-hidden="true" />
          <span>事件报告</span>
        </div>
        {report ? (
          <div className="report-result">
            <div className="report-meta">
              <strong>{String(report.title ?? "报告")}</strong>
              <span className={`severity-${report.severity ?? "medium"}`}>{String(report.severity ?? "medium").toUpperCase()}</span>
            </div>
            <p className="report-summary-text">{String(report.executiveSummary ?? "").slice(0, 300)}</p>
            <div className="report-export-actions">
              <button
                disabled={isGeneratingReport}
                onClick={() => onExportReport("markdown")}
                type="button"
              >
                {isGeneratingReport ? <Loader2 className="spin" size={14} aria-hidden="true" /> : <Download size={14} aria-hidden="true" />}
                <span>下载 .md</span>
              </button>
              <button
                disabled={isGeneratingReport}
                onClick={() => onExportReport("json")}
                type="button"
              >
                <Download size={14} aria-hidden="true" />
                <span>下载 .json</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="report-empty">
            <p className="empty-state">暂无生成的报告</p>
            <button className="report-generate-btn" onClick={onOpenReportDialog} type="button">
              <FileText size={15} aria-hidden="true" />
              <span>生成报告</span>
            </button>
          </div>
        )}
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
      <h3>MCP 工具调用</h3>
      <form className="mcp-form" onSubmit={submitMcpTool}>
        <label className="mcp-field">
          <span>工具</span>
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
          <span>调用工具</span>
        </button>
      </form>
      <div className="mcp-list">
        {mcpTools.map((tool) => (
          <div className="mcp-row" key={tool.name}>
            <strong>{tool.name}</strong>
            <small>{tool.manifest.toolClass} · {tool.manifest.risk}</small>
          </div>
        ))}
      </div>
      <div className="mcp-result">
        <div className="section-label">
          <PlugZap size={14} aria-hidden="true" />
          <span>{permissionMode} 结果</span>
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
            <CollapsibleJson data={mcpResult.invocation.result ?? mcpResult.invocation.error} />
          )
        ) : <p className="empty-state">暂无 MCP 调用</p>}
      </div>
    </div>
  );
}

function manifestFields(manifest: ToolManifest) {
  const required = new Set(manifest.inputSchema.required ?? []);
  return Object.entries(manifest.inputSchema.properties)
    .filter(([, property]) => isRecord(property))
    .map(([name, property]) => ({
      name,
      property: property as Record<string, unknown>,
      required: required.has(name)
    }));
}

function defaultValuesForManifest(manifest: ToolManifest): Record<string, string> {
  const values: Record<string, string> = {};
  for (const { name, property } of manifestFields(manifest)) {
    const enumValues = Array.isArray(property.enum)
      ? property.enum.filter((value): value is string => typeof value === "string")
      : [];
    values[name] = enumValues[0] ?? "";
  }
  return values;
}

function argsFromManifest(manifest: ToolManifest, values: Record<string, string>): Record<string, unknown> {
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
