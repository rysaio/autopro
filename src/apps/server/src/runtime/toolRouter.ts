import type {
  AgentRoutingDecision,
  AgentRunRequest,
  AutomationLevel,
  PermissionMode,
  SkillManifest
} from "@secops-agent/shared";
import type { ToolSet } from "ai";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolContext } from "../tools/types.js";

/** Deterministic local router plus helpers for the temporary layered rollback path. */

/** 工具分类定义 */
export type ToolCategory =
  | "core-triage"      // 核心分诊：IOC 富化、威胁情报、资产查询、MITRE、告警剧本
  | "wazuh-platform"   // Wazuh 平台：Agent 管理、告警搜索、网络分析、Active Response
  | "shuffle-soar"     // Shuffle SOAR：工作流、Webhook、告警转发
  | "reporting"        // 报告生成：事件报告、证据导出
  | "sandbox-actions"; // 沙箱操作：案例笔记、沙箱命令、全权限执行

export interface RouteInput {
  registry: ToolRegistry;
  messages: AgentRunRequest["messages"];
  enabledTools?: string[] | undefined;
  permissionMode: PermissionMode;
  actionLevel: AutomationLevel;
}

/** 工具分类映射：根据 skillPackId 或 apiName 前缀确定类别 */
const SKILLPACK_CATEGORY: Record<string, ToolCategory> = {
  "secops-wazuh": "wazuh-platform",
  "secops-shuffle": "shuffle-soar",
  "secops-reports": "reporting",
};

const CATEGORY_PATTERNS: [string, ToolCategory][] = [
  ["wazuh.", "wazuh-platform"],
  ["shuffle.", "shuffle-soar"],
  ["secops_report_", "reporting"],
  ["secops_case_note_write", "sandbox-actions"],
  ["secops_command_run_sandbox", "sandbox-actions"],
  ["secops_full_access_exec", "sandbox-actions"],
];

interface GenericToolDiscovery {
  manifestId: string;
  deferred: boolean;
  /** Terms derived from validated identity, name, description, tags, and routing hints. */
  terms: string[];
  /** Explicit routing keywords (lower-cased). */
  keywords: string[];
  /** Explicit routing group label (lower-cased). */
  group?: string;
}

export class ToolRouter {
  private categoryMap: Map<ToolCategory, string[]> = new Map();
  private alwaysVisibleIds: string[] = [];
  private deferredIds: string[] = [];
  private genericDiscovery: GenericToolDiscovery[] = [];

  /**
   * 从 ToolRegistry 构建分类映射
   * 基于 manifest 信息自动归类：perception/reasoning 工具按前缀分类。
   * 每次调用都重建（不缓存）：插件 reload 注册新工具后分类必须反映最新注册表。
   */
  build(registry: ToolRegistry): void {
    if (!registry) return; // 安全兜底
    this.categoryMap = new Map<ToolCategory, string[]>([
      ["core-triage", []],
      ["wazuh-platform", []],
      ["shuffle-soar", []],
      ["reporting", []],
      ["sandbox-actions", []],
    ]);
    this.alwaysVisibleIds = [];
    this.deferredIds = [];
    this.genericDiscovery = [];

    const manifests = registry.manifests();
    for (const m of manifests) {
      if (m.deferLoading) {
        this.deferredIds.push(m.id);
      } else {
        this.alwaysVisibleIds.push(m.id);
      }
      // 核心分诊工具：SecOps Core 的 perception/reasoning 工具
      if (m.skillPackId === "secops-core") {
        this.categoryMap.get("core-triage")!.push(m.id);
        continue;
      }
      // 按 skillPackId 分类
      if (m.skillPackId) {
        const cat = SKILLPACK_CATEGORY[m.skillPackId];
        if (cat) {
          this.categoryMap.get(cat)!.push(m.id);
          continue;
        }
      }
      // 动作工具
      if (m.toolClass === "action") {
        const platformCategory = CATEGORY_PATTERNS.find(([prefix]) => m.id.startsWith(prefix))?.[1];
        this.categoryMap.get(platformCategory ?? "sandbox-actions")!.push(m.id);
        if (!platformCategory) {
          this.genericDiscovery.push(genericDiscoveryFor(m));
        }
        continue;
      }
      // 按前缀匹配
      let matched = false;
      for (const [prefix, category] of CATEGORY_PATTERNS) {
        if (m.id.startsWith(prefix)) {
          this.categoryMap.get(category)!.push(m.id);
          matched = true;
          break;
        }
      }
      if (!matched) {
        // 未匹配的归入 core-triage
        this.categoryMap.get("core-triage")!.push(m.id);
        this.genericDiscovery.push(genericDiscoveryFor(m));
      }
    }
  }

  /** Build a deterministic local route before the final model execution. */
  route(input: RouteInput): AgentRoutingDecision {
    this.build(input.registry);
    const latestUserMessage = [...input.messages].reverse().find((message) => message.role === "user");
    const latestIntent = latestUserMessage?.content.trim() ?? "";
    const usesConversationContext = shouldUseConversationContext(latestIntent);
    const context = usesConversationContext
      ? input.messages
        .filter((message) => message !== latestUserMessage && (message.role === "user" || message.role === "assistant"))
        .slice(-4)
        .map((message) => message.content)
        .join(" ")
      : "";
    const routingText = `${context} ${latestIntent}`.trim();
    const groups = inferIntentCategories(routingText);
    const reasons: string[] = [];
    let candidateIds: string[] = [];
    let confidence: AgentRoutingDecision["confidence"];

    if (input.enabledTools?.length === 0) {
      confidence = { level: "high", score: 1 };
      reasons.push("The request explicitly enabled an empty tool set, so no tools can be exposed.");
    } else if (isExplicitNoToolRequest(latestIntent)) {
      confidence = { level: "high", score: 0.99 };
      reasons.push("The latest user intent explicitly requests a response without tools.");
    } else if (groups.length === 1) {
      candidateIds = this.getIntentToolIds(groups, input.registry, routingText);
      const discovered = this.discoverGenericTools(routingText);
      if (discovered.length > 0) {
        candidateIds = [...new Set([...candidateIds, ...discovered])];
        reasons.push("Generic plugin routing hints matched deferred tools without relying on first-party prefixes.");
      }
      confidence = { level: "high", score: 0.9 };
      reasons.push(`The latest user intent maps deterministically to ${groups[0]}.`);
    } else if (groups.length > 1) {
      candidateIds = this.getIntentToolIds(groups, input.registry, routingText);
      const discovered = this.discoverGenericTools(routingText);
      if (discovered.length > 0) {
        candidateIds = [...new Set([...candidateIds, ...discovered])];
        reasons.push("Generic plugin routing hints matched deferred tools without relying on first-party prefixes.");
      }
      confidence = { level: "medium", score: 0.68 };
      reasons.push(`The request spans ${groups.join(", ")}; the cross-domain route was resolved locally.`);
    } else if (isClearlyNoToolRequest(latestIntent)) {
      confidence = { level: "high", score: 0.88 };
      reasons.push("The latest user intent is conversational or explanatory and has no operational tool signal.");
    } else {
      const discovered = this.discoverGenericTools(routingText);
      if (discovered.length > 0) {
        candidateIds = [...new Set([...this.alwaysVisibleIds, ...discovered])];
        confidence = { level: "medium", score: 0.68 };
        reasons.push("No first-party domain matched; generic plugin routing hints selected deferred tools for this request.");
      } else {
        candidateIds = [...this.alwaysVisibleIds];
        confidence = { level: "low", score: 0.35 };
        reasons.push("No deterministic domain matched; fallback exposes only eligible non-action resident tools.");
      }
    }

    if (usesConversationContext) {
      reasons.push("Recent valid user and assistant context was used to resolve a follow-up intent.");
    }

    const selectedToolIds = this.filterEligibleToolIds(candidateIds, input, routingText);
    if (candidateIds.length > selectedToolIds.length) {
      reasons.push("The candidate route was intersected with enabled tools and current action policy.");
    }

    return {
      mode: "deterministic",
      selectedToolIds,
      groups,
      confidence,
      reasons,
      additionalModelStage: {
        used: false,
        reason: confidence.level === "low"
          ? "Low confidence remains on the documented local fallback; no routing model is invoked."
          : groups.length > 1
            ? "Cross-domain intent was resolved by deterministic rules; no routing model is needed."
            : "The deterministic route is sufficient."
      }
    };
  }

  filterEligibleToolIds(
    toolIds: string[],
    input: Pick<RouteInput, "registry" | "enabledTools" | "permissionMode" | "actionLevel">,
    intentText: string
  ): string[] {
    const enabled = input.enabledTools === undefined ? undefined : new Set(input.enabledTools);
    const manifests = new Map(input.registry.manifests().map((manifest) => [manifest.id, manifest]));
    const selected: string[] = [];

    for (const id of new Set(toolIds)) {
      const manifest = manifests.get(id);
      if (!manifest || (enabled && !enabled.has(id))) {
        continue;
      }
      if (manifest.toolClass === "action" && !isActionExposable(manifest, input, intentText)) {
        continue;
      }
      selected.push(id);
    }
    return selected;
  }

  getCategoryToolIds(categories: ToolCategory[]): string[] {
    const toolIds = new Set<string>();
    for (const category of categories) {
      for (const id of this.categoryMap.get(category) ?? []) {
        toolIds.add(id);
      }
    }
    return [...toolIds];
  }

  private getIntentToolIds(categories: ToolCategory[], registry: ToolRegistry, intentText: string): string[] {
    const manifests = new Map(registry.manifests().map((manifest) => [manifest.id, manifest]));
    const selected = new Set<string>();
    for (const category of categories) {
      const categoryIds = this.getCategoryToolIds([category]);
      const scored = categoryIds.map((id) => ({
        id,
        score: toolRelevanceScore(manifests.get(id), intentText)
      }));
      const highestScore = Math.max(0, ...scored.map((item) => item.score));
      const narrowed = highestScore === 0
        ? categoryIds.filter((id) => !this.isDeferredGeneric(id))
        : scored.filter((item) => item.score === highestScore).map((item) => item.id);
      for (const id of narrowed) {
        selected.add(id);
      }
    }
    return [...selected];
  }

  /** True for unknown (unclassified) deferred plugin tools that must not leak into unrelated category routes. */
  private isDeferredGeneric(manifestId: string): boolean {
    return this.genericDiscovery.some((entry) => entry.manifestId === manifestId && entry.deferred);
  }

  /**
   * Deterministic generic discovery for unknown (unclassified) plugin tools.
   * Only deferred tools are considered: resident tools are already visible, so
   * this keeps unknown tools discoverable without making them permanently
   * resident or sending them on every unrelated request.
   */
  private discoverGenericTools(intentText: string): string[] {
    const text = intentText.toLowerCase();
    const scored: Array<{ id: string; score: number; explicit: boolean }> = [];
    for (const entry of this.genericDiscovery) {
      if (!entry.deferred) {
        continue;
      }
      let score = 0;
      let explicit = false;
      for (const keyword of entry.keywords) {
        if (text.includes(keyword)) {
          score += 4;
          explicit = true;
        }
      }
      if (entry.group && text.includes(entry.group)) {
        score += 2;
        explicit = true;
      }
      for (const term of entry.terms) {
        if (intentContainsTerm(text, term)) {
          score += 1;
        }
      }
      if (score >= 2 || explicit) {
        scored.push({ id: entry.manifestId, score, explicit });
      }
    }
    scored.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
    const highestScore = scored[0]?.score ?? 0;
    return scored
      .filter((item) => item.score === highestScore)
      .map((item) => item.id);
  }

  /**
   * 获取 Phase 1 分诊工具 ID 列表（所有常驻工具）
   */
  getTriageToolIds(): string[] {
    return [...this.alwaysVisibleIds];
  }

  /**
   * 获取 Phase 1 分诊工具集（所有常驻工具）
   * 这是 LLM 第一轮接收的最小工具集，用于快速确定意图
   */
  getTriageToolSet(registry: ToolRegistry, context: ToolContext): ToolSet {
    this.build(registry);
    const triageIds = this.getTriageToolIds();
    return registry.aiSdkTools(context, triageIds);
  }

  /**
   * 根据 Phase 1 结果推断需要加载的专用工具类别
   * 
   * 意图推断规则：
   * - 任何 wazuh_ 工具被调用 → 加载 wazuh-platform
   * - 任何 shuffle_ 工具被调用 → 加载 shuffle-soar
   * - 检测到特定关键词 → 加载对应类别
   * - 默认：加载全部工具（兜底）
   */
  inferCategories(triageToolCalls: string[], userMessage: string): ToolCategory[] {
    const categories = new Set<ToolCategory>(["core-triage"]); // 核心工具始终加载

    // 规则 1：根据已调用的工具推断
    for (const call of triageToolCalls) {
      if (call.startsWith("secops_wazuh_")) categories.add("wazuh-platform");
      if (call.startsWith("secops_shuffle_")) categories.add("shuffle-soar");
      if (call.startsWith("secops_report_")) categories.add("reporting");
      if (
        call === "secops_case_note_write" ||
        call === "secops_command_run_sandbox" ||
        call === "secops_full_access_exec"
      ) {
        categories.add("sandbox-actions");
      }
    }

    // 规则 2：根据用户消息关键词推断（语义路由）
    const msg = userMessage.toLowerCase();
    if (
      msg.includes("agent") || msg.includes("wazuh") || msg.includes("告警") ||
      msg.includes("主机") || msg.includes("端口") || msg.includes("进程") ||
      msg.includes("横向") || msg.includes("封禁") || msg.includes("block") ||
      msg.includes("拉黑") || msg.includes("拦截") || msg.includes("检测") ||
      msg.includes("排查") || msg.includes("监控") || msg.includes("防护") ||
      msg.includes("入侵") || msg.includes("漏洞") || msg.includes("威胁")
    ) {
      categories.add("wazuh-platform");
    }
    if (msg.includes("shuffle") || msg.includes("soar") || msg.includes("workflow") ||
      msg.includes("工作流") || msg.includes("webhook") || msg.includes("编排")
    ) {
      categories.add("shuffle-soar");
    }
    if (msg.includes("报告") || msg.includes("report") || msg.includes("导出") ||
      msg.includes("export") || msg.includes("证据") || msg.includes("总结") ||
      msg.includes("分析报告")
    ) {
      categories.add("reporting");
    }
    if (msg.includes("执行") || msg.includes("命令") || msg.includes("exec") ||
      msg.includes("运行") || msg.includes("run") || msg.includes("笔记") ||
      msg.includes("案例") || msg.includes("沙箱") || msg.includes("note")
    ) {
      categories.add("sandbox-actions");
    }

    // 安全相关关键词 → 可能需要 Wazuh
    if (
      msg.includes("安全") || msg.includes("攻击") || msg.includes("威胁") ||
      msg.includes("漏洞") || msg.includes("入侵") || msg.includes("断开") ||
      msg.includes("离线") || msg.includes("异常")
    ) {
      categories.add("wazuh-platform");
    }

    return [...categories];
  }

  /**
   * 获取 Phase 2 专用工具 ID 列表
   */
  getSpecializedToolIds(categories: ToolCategory[]): string[] {
    const toolIds = new Set(this.getCategoryToolIds(categories));
    if (toolIds.size === 0) {
      // 兜底：返回全部工具
      const all = new Set<string>();
      for (const ids of this.categoryMap.values()) {
        for (const id of ids) all.add(id);
      }
      return [...all];
    }
    return [...toolIds];
  }

  /** 获取 Phase 2 工具：全部常驻工具 + 类别推断命中的按需工具。 */
  getDeepToolIds(categories: ToolCategory[]): string[] {
    const deferred = new Set(this.deferredIds);
    const specializedDeferredIds = this.getSpecializedToolIds(categories)
      .filter((id) => deferred.has(id));
    return [...new Set([...this.alwaysVisibleIds, ...specializedDeferredIds])];
  }

  /**
   * 获取 Phase 2 专用工具集
   * 根据推断的类别加载对应工具
   */
  getSpecializedToolSet(
    registry: ToolRegistry,
    context: ToolContext,
    categories: ToolCategory[]
  ): ToolSet {
    this.build(registry);
    const toolIds = new Set<string>();
    for (const cat of categories) {
      const ids = this.categoryMap.get(cat) ?? [];
      for (const id of ids) toolIds.add(id);
    }
    if (toolIds.size === 0) {
      // 兜底：返回全部工具
      return registry.aiSdkTools(context);
    }
    return registry.aiSdkTools(context, [...toolIds]);
  }

  /** 获取分类统计信息（用于日志/前端展示） */
  getCategorySummary(): Record<ToolCategory, { count: number; tokens: number }> {
    const summary: Record<string, { count: number; tokens: number }> = {};
    const AVG_TOKENS_PER_TOOL = 160; // 平均每个工具的 schema 约 160 tokens
    for (const [cat, ids] of this.categoryMap) {
      summary[cat] = {
        count: ids.length,
        tokens: ids.length * AVG_TOKENS_PER_TOOL
      };
    }
    return summary as Record<ToolCategory, { count: number; tokens: number }>;
  }

  /** 估算节省的 token 数 */
  estimateTokenSavings(categories: ToolCategory[]): number {
    const AVG_TOKENS_PER_TOOL = 160;
    const allToolCount = Array.from(this.categoryMap.values()).reduce((sum, ids) => sum + ids.length, 0);
    const loadedCount = categories.reduce((sum, cat) => sum + (this.categoryMap.get(cat)?.length ?? 0), 0);
    return (allToolCount - loadedCount) * AVG_TOKENS_PER_TOOL;
  }
}

function inferIntentCategories(value: string): ToolCategory[] {
  const text = value.toLowerCase();
  const categories = new Set<ToolCategory>();
  if (matches(text, [
    "ioc", "indicator", "hash", "domain", "url", "threat intel", "威胁情报", "指标",
    "asset", "inventory", "host", "资产", "主机", "sigma", "detection rule", "检测规则",
    "mitre", "attack technique", "攻击技术", "playbook", "剧本"
  ]) || /\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(text) || /\b[a-f0-9]{32,64}\b/.test(text)) {
    categories.add("core-triage");
  }
  if (matches(text, [
    "wazuh", "告警", "agent", "端口", "进程", "横向", "active response",
    "封禁", "拉黑", "拦截", "入侵", "网络暴露"
  ])) {
    categories.add("wazuh-platform");
  }
  if (matches(text, ["shuffle", "soar", "workflow", "工作流", "webhook", "编排"])) {
    categories.add("shuffle-soar");
  }
  if (matches(text, ["report", "报告", "export", "导出", "evidence pack", "证据包"])) {
    categories.add("reporting");
  }
  if (matches(text, [
    "write note", "add note", "case note", "记录笔记", "写笔记", "添加笔记",
    "run command", "execute command", "执行命令", "运行命令", "full access", "全权限"
  ])) {
    categories.add("sandbox-actions");
  }
  return [...categories];
}

function toolRelevanceScore(manifest: SkillManifest | undefined, intentText: string): number {
  if (!manifest) {
    return 0;
  }
  const searchable = [manifest.id, manifest.name, ...manifest.tags].join(" ").toLowerCase();
  return intentSignals(intentText).reduce(
    (score, signal) => score + (searchable.includes(signal) ? 1 : 0),
    0
  );
}

function genericDiscoveryFor(manifest: SkillManifest): GenericToolDiscovery {
  const routing = manifest.routing;
  const searchable = [
    manifest.id,
    manifest.name,
    manifest.description,
    ...manifest.tags,
    ...(routing?.keywords ?? [])
  ].join(" ");
  return {
    manifestId: manifest.id,
    deferred: manifest.deferLoading,
    terms: deriveSearchTerms(searchable),
    keywords: (routing?.keywords ?? []).map((keyword) => keyword.toLowerCase()).filter(Boolean),
    ...(routing?.group ? { group: routing.group.toLowerCase() } : {})
  };
}

/**
 * Derives stable search terms from a tool's validated routing surface.
 * English tokens keep word-boundary matching; CJK runs are split into 2-grams
 * so both the intent and the tool description can overlap on shared phrases.
 */
function deriveSearchTerms(value: string): string[] {
  const text = value.toLowerCase();
  const ignored = new Set([
    "agent", "wazuh", "shuffle", "secops", "mcp", "tool", "tools", "plugin",
    "the", "and", "for", "with", "this", "that", "from", "into", "use", "using",
    "via", "all", "any", "can", "will", "your", "you"
  ]);
  const terms = new Set<string>();
  for (const token of text.match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? []) {
    if (!ignored.has(token)) {
      terms.add(token);
    }
  }
  for (const run of text.match(/[\u4e00-\u9fff]{2,}/g) ?? []) {
    if (run.length <= 8) {
      terms.add(run);
    }
    if (run.length >= 3) {
      for (let index = 0; index < run.length - 1; index += 1) {
        terms.add(run.slice(index, index + 2));
      }
    }
  }
  return [...terms];
}

function intentContainsTerm(intentText: string, term: string): boolean {
  if (/[\u4e00-\u9fff]/.test(term)) {
    return intentText.includes(term);
  }
  return new RegExp(`(?:^|[^a-z0-9_-])${escapeRegExp(term)}(?:$|[^a-z0-9_-])`, "i").test(intentText);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function intentSignals(value: string): string[] {
  const text = value.toLowerCase();
  const ignored = new Set([
    "agent", "wazuh", "shuffle", "secops", "investigate", "investigation", "please",
    "with", "this", "that", "from", "into", "tool", "tools"
  ]);
  const signals = new Set(
    text.match(/[a-z0-9][a-z0-9_-]{2,}/g)?.filter((token) => !ignored.has(token)) ?? []
  );
  const aliases: Array<[string, string[]]> = [
    ["告警", ["alert", "alerts"]],
    ["端口", ["port", "ports"]],
    ["进程", ["process", "processes"]],
    ["横向", ["lateral"]],
    ["封禁", ["block"]],
    ["拉黑", ["block"]],
    ["配置", ["config", "configuration"]],
    ["状态", ["status", "health"]],
    ["工作流", ["workflow"]],
    ["报告", ["report"]],
    ["导出", ["export"]],
    ["证据", ["evidence"]],
    ["资产", ["asset", "inventory"]],
    ["主机", ["host", "asset", "agent"]],
    ["检测规则", ["detection", "rule", "sigma"]],
    ["威胁情报", ["threat-intel", "ioc"]]
  ];
  for (const [term, mapped] of aliases) {
    if (text.includes(term)) {
      mapped.forEach((signal) => signals.add(signal));
    }
  }
  if (/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(text) || /\b[a-f0-9]{32,64}\b/.test(text)) {
    signals.add("ioc");
  }
  return [...signals];
}

function isActionExposable(
  manifest: SkillManifest,
  policy: Pick<RouteInput, "permissionMode" | "actionLevel">,
  intentText: string
): boolean {
  if (policy.actionLevel === "observe" || (policy.actionLevel !== "full-access" && policy.permissionMode === "deny")) {
    return false;
  }
  if (manifest.id === "full_access.exec" && policy.actionLevel !== "full-access") {
    return false;
  }
  const text = intentText.toLowerCase();
  if (manifest.id === "case.note.write") {
    return matches(text, ["write note", "add note", "case note", "记录笔记", "写笔记", "添加笔记"]);
  }
  if (manifest.id === "command.run.sandbox") {
    return matches(text, ["run command", "execute command", "执行命令", "运行命令", "git status", "node version"]);
  }
  if (manifest.id === "full_access.exec") {
    return matches(text, ["full access", "full-access", "全权限"]);
  }
  if (manifest.id.includes("block") || manifest.tags.some((tag) => tag.includes("block") || tag === "active-response")) {
    return matches(text, ["block", "封禁", "拉黑", "拦截", "active response"]);
  }
  if (manifest.id.includes("workflow") || manifest.tags.includes("workflow")) {
    return matches(text, ["execute workflow", "run workflow", "执行工作流", "运行工作流", "触发工作流"]);
  }
  const actionRequested = matches(text, ["execute", "run", "write", "create", "执行", "运行", "写入", "创建", "触发"]);
  const manifestTerms = [...manifest.tags, manifest.id, manifest.name]
    .flatMap((term) => term.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/))
    .filter((term) => term.length >= 3 && term !== "action");
  return actionRequested && manifestTerms.some((term) => text.includes(term));
}

function isExplicitNoToolRequest(value: string): boolean {
  return /\b(no tools?|without (?:calling|using) (?:a )?tools?|do not (?:call|use) tools?|don't (?:call|use) tools?)\b/i.test(value)
    || /不要(?:调用|使用)工具|无需工具|不使用工具/.test(value);
}

function isClearlyNoToolRequest(value: string): boolean {
  const text = value.trim().toLowerCase();
  return text.length === 0
    || /^(hi|hello|hey|thanks|thank you|ok|okay|acknowledge)\b/.test(text)
    || /^(你好|您好|谢谢|确认|收到)/.test(text)
    || matches(text, ["explain", "define", "translate", "what is", "解释", "定义", "翻译", "是什么"]);
}

function shouldUseConversationContext(value: string): boolean {
  const text = value.trim().toLowerCase();
  return text.length < 80 && (
    /\b(it|that|this|those|them|same|also|then|continue)\b/.test(text)
    || /(这个|那个|它|它们|上述|同样|继续|接着|然后|也)/.test(text)
  );
}

function matches(value: string, terms: string[]): boolean {
  return terms.some((term) => value.includes(term));
}

/** 全局单例 */
export const toolRouter = new ToolRouter();
