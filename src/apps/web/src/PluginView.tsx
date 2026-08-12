import { AlertTriangle, CheckCircle2, Loader2, PlugZap, RefreshCw } from "lucide-react";
import { useState } from "react";
import type { PluginSummary } from "@secops-agent/shared";

interface PluginViewProps {
  plugins: PluginSummary[];
  onReload: () => Promise<PluginSummary[]>;
}

export function PluginView({ plugins, onReload }: PluginViewProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
          {plugins.length ? plugins.map((plugin) => (
            <div className={`plugin-row status-${plugin.status}`} key={plugin.id}>
              <div className="plugin-heading">
                {plugin.status === "loaded" ? <CheckCircle2 size={16} aria-hidden="true" /> : <AlertTriangle size={16} aria-hidden="true" />}
                <div><strong>{plugin.name}</strong><small>{plugin.version || "未标注版本"} · {plugin.status}</small></div>
                <div className="plugin-counts"><span>{plugin.skillCount} 技能</span><span>{plugin.toolCount} 工具</span></div>
              </div>
              {plugin.description ? <p>{plugin.description}</p> : null}
              {plugin.mcpServers?.length ? <div className="plugin-mcp-list">{plugin.mcpServers.map((server) => (
                <span className={`status-${server.status}`} key={server.name}><PlugZap size={13} aria-hidden="true" />{server.name} · {server.status} · {server.toolCount} 工具</span>
              ))}</div> : <p className="empty-state">该插件未声明 MCP 服务</p>}
              {plugin.error ? <small className="catalog-error">{plugin.error}</small> : null}
            </div>
          )) : <p className="empty-state">暂无插件</p>}
        </div>
      </section>
      {error ? <div className="mcp-config-message error" role="alert"><AlertTriangle size={15} aria-hidden="true" /><span>{error}</span></div> : null}
    </div>
  );
}
