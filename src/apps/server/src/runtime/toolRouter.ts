import type { ToolSet } from "ai";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolContext } from "../tools/types.js";

/**
 * 分层工具路由器 (Layered Tool Router)
 *
 * 创新点：将 37 个工具按语义分类，采用"先路由后加载"的两阶段策略：
 *  Phase 1 (Triage): 仅发送 5 个核心分诊工具（~800 tokens），快速确定意图
 *  Phase 2 (Specialized): 根据 Phase 1 结果，动态加载对应领域的专用工具
 *
 * 相比传统"一股脑全塞进去"的做法（37 工具 ~6000 tokens），
 * Phase 1 节省 ~85% 的 tool schema token 开销。
 */

/** 工具分类定义 */
export type ToolCategory =
  | "core-triage"      // 核心分诊：IOC 富化、威胁情报、资产查询、MITRE、告警剧本
  | "wazuh-platform"   // Wazuh 平台：Agent 管理、告警搜索、网络分析、Active Response
  | "shuffle-soar"     // Shuffle SOAR：工作流、Webhook、告警转发
  | "reporting"        // 报告生成：事件报告、证据导出
  | "sandbox-actions"; // 沙箱操作：案例笔记、沙箱命令、全权限执行

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

export class ToolRouter {
  private categoryMap: Map<ToolCategory, string[]> = new Map();
  private initialized = false;

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

    const manifests = registry.manifests();
    for (const m of manifests) {
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
        this.categoryMap.get("sandbox-actions")!.push(m.id);
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
      }
    }
    this.initialized = true;
  }

  /**
   * 获取 Phase 1 分诊工具 ID 列表（仅核心工具）
   */
  getTriageToolIds(): string[] {
    this.build(null!); // 确保已初始化（build 在 registry 可用时调用）
    return this.categoryMap.get("core-triage") ?? [];
  }

  /**
   * 获取 Phase 1 分诊工具集（仅核心工具，~5个）
   * 这是 LLM 第一轮接收的最小工具集，用于快速确定意图
   */
  getTriageToolSet(registry: ToolRegistry, context: ToolContext): ToolSet {
    this.build(registry);
    const triageIds = this.categoryMap.get("core-triage") ?? [];
    if (triageIds.length === 0) {
      // 如果核心工具为空，返回前 5 个工具
      return registry.aiSdkTools(context, registry.manifests().slice(0, 5).map((m) => m.id));
    }
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
    this.build(null!);
    const toolIds = new Set<string>();
    for (const cat of categories) {
      const ids = this.categoryMap.get(cat) ?? [];
      for (const id of ids) toolIds.add(id);
    }
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

/** 全局单例 */
export const toolRouter = new ToolRouter();