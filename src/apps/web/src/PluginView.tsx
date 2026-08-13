import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Loader2, PlugZap, RefreshCw } from "lucide-react";
import { useState } from "react";
import type { PluginSummary, ToolManifest } from "@secops-agent/shared";

interface PluginViewProps {
  plugins: PluginSummary[];
  onReload: () => Promise<PluginSummary[]>;
  /** 全部工具清单，用于按 tags 归属到插件（插件 MCP 工具 tags 含 pluginId）。 */
  tools: ToolManifest[];
  enabledTools: ReadonlySet<string>;
  /** full-access 模式下工具开关由部署级别接管，界面只读。 */
  fullAccessActive: boolean;
  onToggleTool: (id: string) => void;
  onTogglePlugin: (pluginId: string, enabled: boolean) => void;
}

export function PluginView({
  plugins,
  onReload,
  tools,
  enabledTools,
  fullAccessActive,
  onToggleTool,
  onTogglePlugin
}: PluginViewProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const loaded = plugins.filter((plugin) => plugin.status === "loaded").length;
  const failed = plugins.length - loaded;

  async function reload() {
    setBusy(true);
    setError(null);
    try {
      await onReload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="catalog-workspace plugin-workspace">
      <section className="config-section wide catalog-overview">
        <div className="section-label"><PlugZap size={14} aria-hidden="true" /><span>插件目录</span></div>
        <div className="catalog-facts">
          <div><strong>{plugins.length}</strong><span>插件</span></div>
          <div><strong>{loaded}</strong><span>已加载</span></div>
          <div className={failed ? "warn" : ""}><strong>{failed}</strong><span>异常</span></div>
        </div>
        <div className="config-actions">
          <button disabled={busy} onClick={() => void reload()} type="button">
            {busy ? <Loader2 className="spin" size={15} aria-hidden="true" /> : <RefreshCw size={15} aria-hidden="true" />}
            <span>重新加载插件</span>
          </button>
        </div>
      </section>

      <section className="config-section wide plugin-section">
        <div className="section-label"><PlugZap size={14} aria-hidden="true" /><span>已安装插件</span></div>
        <div className="plugin-list">
          {plugins.length ? plugins.map((plugin) => {
            const pluginTools = tools.filter((tool) => tool.tags.includes(plugin.id));
            const anyEnabled = pluginTools.some((tool) => enabledTools.has(tool.id));
            const allEnabled = pluginTools.length > 0 && pluginTools.every((tool) => enabledTools.has(tool.id));
            const expanded = expandedId === plugin.id;
            return (
              <div className={`plugin-row status-${plugin.status}`} key={plugin.id}>
                <div className="plugin-heading">
                  {plugin.status === "loaded" ? <CheckCircle2 size={16} aria-hidden="true" /> : <AlertTriangle size={16} aria-hidden="true" />}
                  <div><strong>{plugin.name}</strong><small>{plugin.version || "未标注版本"} · {plugin.status}</small></div>
                  <div className="plugin-counts"><span>{plugin.skillCount} 技能</span><span>{plugin.toolCount} 工具</span></div>
                  {pluginTools.length > 0 ? (
                    <label className="toggle" title={allEnabled ? "点击禁用该插件的全部工具" : "点击启用该插件的全部工具"}>
                      <input
                        aria-label={`启用插件 ${plugin.name} 的全部工具`}
                        checked={fullAccessActive || allEnabled}
                        disabled={fullAccessActive}
                        onChange={() => onTogglePlugin(plugin.id, !allEnabled)}
                        ref={(el) => {
                          if (el) {
                            el.indeterminate = !fullAccessActive && anyEnabled && !allEnabled;
                          }
                        }}
                        type="checkbox"
                      />
                      <span className="toggle-track" aria-hidden="true" />
                    </label>
                  ) : null}
                  {pluginTools.length > 0 ? (
                    <button
                      aria-expanded={expanded}
                      className="plugin-expand"
                      onClick={() => setExpandedId(expanded ? null : plugin.id)}
                      title={expanded ? "收起工具" : "展开工具，勾选启用范围"}
                      type="button"
                    >
                      {expanded ? <ChevronDown size={15} aria-hidden="true" /> : <ChevronRight size={15} aria-hidden="true" />}
                    </button>
                  ) : null}
                </div>
                {plugin.description ? <p>{plugin.description}</p> : null}
                {plugin.mcpServers?.length ? <div className="plugin-mcp-list">{plugin.mcpServers.map((server) => (
                  <span className={`status-${server.status}`} key={server.name}><PlugZap size={13} aria-hidden="true" />{server.name} · {server.status} · {server.toolCount} 工具</span>
                ))}</div> : <p className="empty-state">该插件未声明 MCP 服务</p>}
                {plugin.error ? <small className="catalog-error">{plugin.error}</small> : null}
                {expanded ? (
                  <div className="plugin-tools" aria-label={`${plugin.name} 工具`}>
                    <div className="section-label"><PlugZap size={14} aria-hidden="true" /><span>工具开关（{pluginTools.filter((tool) => enabledTools.has(tool.id)).length}/{pluginTools.length}）</span></div>
                    {pluginTools.length ? pluginTools.map((tool) => (
                      <label className="tool-row" key={tool.id}>
                        <input
                          checked={fullAccessActive || enabledTools.has(tool.id)}
                          disabled={fullAccessActive}
                          onChange={() => onToggleTool(tool.id)}
                          type="checkbox"
                        />
                        <span className="tool-copy">
                          <strong>{tool.name}</strong>
                          <span className="tool-badges">
                            <em>{tool.toolClass}</em>
                            <em className={`risk-${tool.risk}`}>{tool.risk}</em>
                            <em>MCP</em>
                          </span>
                        </span>
                      </label>
                    )) : <p className="empty-state">该插件未提供工具</p>}
                  </div>
                ) : null}
              </div>
            );
          }) : <p className="empty-state">暂无插件</p>}
        </div>
      </section>
      {error ? <div className="mcp-config-message error" role="alert"><AlertTriangle size={15} aria-hidden="true" /><span>{error}</span></div> : null}
    </div>
  );
}
