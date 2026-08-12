import type { EnvironmentStatus } from "@secops-agent/shared";
import type { PluginManager } from "../plugins/pluginManager.js";
import type { SkillCatalog } from "../skills/catalog.js";
import type { ModelConfigStore } from "./modelConfigStore.js";
import type { RuntimeSettingsStore } from "./runtimeSettings.js";

/**
 * AgentEnvironment：agent 运行基座，统一管理 agent 应用的配置与外围设施。
 * - settings：运行时设置（actionLevel，RuntimeSettingsStore）
 * - models：模型连接注册表（ModelConfigStore）
 * - plugins：插件外围设施（PluginManager，MCP 工具链）
 *
 * 统一启动加载顺序与状态聚合；各资源保持自己的热更新语义
 * （模型=写文件即生效，插件=断开重连，设置=写文件即生效），
 * 不做统一 CRUD、不做跨资源事务，避免泄漏抽象。
 */
export class AgentEnvironment {
  constructor(
    private readonly settings: RuntimeSettingsStore,
    private readonly models: ModelConfigStore,
    private readonly plugins: PluginManager,
    private readonly skills: SkillCatalog
  ) {}

  /** 启动加载：settings/models 在构造时已从持久层读取，此处补齐插件扫描加载。 */
  async loadAll(): Promise<void> {
    await this.plugins.load();
    this.reloadSkills();
  }

  /** 热更新：各资源按自身语义重载（当前插件需重连，模型/设置写文件即生效）。 */
  async reloadAll(): Promise<void> {
    await this.plugins.reload();
    this.reloadSkills();
  }

  /** 聚合环境状态：模型连接 + 插件外围设施 + 运行时设置。 */
  status(): EnvironmentStatus {
    const modelStatus = this.models.status();
    const plugins = this.plugins.status();
    return {
      model: {
        configured: modelStatus.configured,
        provider: modelStatus.provider,
        model: modelStatus.model,
        ...(modelStatus.baseUrl ? { baseUrl: modelStatus.baseUrl } : {}),
        connections: modelStatus.connections,
        activeConnectionId: modelStatus.activeConnectionId
      },
      plugins: {
        installed: plugins.length,
        loaded: plugins.filter((plugin) => plugin.status === "loaded" || plugin.status === "degraded").length,
        failed: plugins.filter((plugin) => plugin.status === "error").length,
        plugins
      },
      settings: this.settings.get()
    };
  }

  private reloadSkills(): void {
    const skills = this.skills.reload(this.plugins.skillSources());
    this.plugins.applySkillResults(skills);
  }
}
