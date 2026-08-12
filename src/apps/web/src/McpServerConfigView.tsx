import {
  AlertTriangle,
  CheckCircle2,
  CircleOff,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Server,
  Trash2,
  X
} from "lucide-react";
import { useState } from "react";
import type { FormEvent } from "react";
import type { McpServerConfigState, McpServerSummary, McpServerTransport } from "@secops-agent/shared";
import {
  addMcpServer,
  reconnectMcpServer,
  reloadMcpServers,
  removeMcpServer,
  updateMcpServer,
  type McpServerInput
} from "./api.js";

interface McpServerConfigViewProps {
  state: McpServerConfigState;
  onChanged: (state: McpServerConfigState) => void | Promise<void>;
}

interface ServerForm {
  id: string | null;
  name: string;
  transport: McpServerTransport;
  enabled: boolean;
  command: string;
  args: string;
  cwd: string;
  env: string;
  url: string;
  headers: string;
  envTouched: boolean;
  headersTouched: boolean;
}

const EMPTY_FORM: ServerForm = {
  id: null,
  name: "",
  transport: "stdio",
  enabled: true,
  command: "",
  args: "",
  cwd: "",
  env: "",
  url: "",
  headers: "",
  envTouched: false,
  headersTouched: false
};

export function McpServerConfigView({ state, onChanged }: McpServerConfigViewProps) {
  const [form, setForm] = useState<ServerForm>(EMPTY_FORM);
  const [formOpen, setFormOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const connected = state.servers.filter((server) => server.status === "connected").length;
  const failed = state.servers.filter((server) => server.status === "error").length;

  async function runAction(
    id: string,
    action: () => Promise<McpServerConfigState>,
    message: string
  ): Promise<boolean> {
    setBusyId(id);
    setError(null);
    setSuccess(null);
    try {
      const result = await action();
      await onChanged(result);
      setSuccess(message);
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return false;
    } finally {
      setBusyId(null);
    }
  }

  function openCreate() {
    setForm(EMPTY_FORM);
    setFormOpen(true);
    setError(null);
  }

  function openEdit(server: McpServerSummary) {
    setForm({
      id: server.id,
      name: server.name,
      transport: server.transport,
      enabled: server.enabled,
      command: server.command ?? "",
      args: server.args?.join("\n") ?? "",
      cwd: server.cwd ?? "",
      env: "",
      url: server.url ?? "",
      headers: "",
      envTouched: false,
      headersTouched: false
    });
    setFormOpen(true);
    setError(null);
  }

  function closeForm() {
    setFormOpen(false);
    setForm(EMPTY_FORM);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const input = formInput(form);
      const editingId = form.id;
      const saved = await runAction(
        editingId ?? "new",
        () => editingId ? updateMcpServer(editingId, input) : addMcpServer(input as McpServerInput),
        editingId ? "MCP 服务已更新" : "MCP 服务已添加"
      );
      if (saved) {
        closeForm();
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  function toggleEnabled(server: McpServerSummary) {
    void runAction(
      server.id,
      () => updateMcpServer(server.id, { enabled: !server.enabled }),
      `${server.name} 已${server.enabled ? "停用" : "启用"}`
    );
  }

  function remove(server: McpServerSummary) {
    if (!window.confirm(`确认删除 MCP 服务「${server.name}」？`)) {
      return;
    }
    void runAction(server.id, () => removeMcpServer(server.id), `${server.name} 已删除`);
  }

  return (
    <div className="mcp-server-config">
      <section className="config-section wide mcp-server-overview">
        <div className="section-label">
          <Server size={14} aria-hidden="true" />
          <span>MCP 服务</span>
        </div>
        <div className="mcp-server-facts">
          <div><strong>{state.servers.length}</strong><span>服务</span></div>
          <div><strong>{connected}</strong><span>已连接</span></div>
          <div className={failed ? "warn" : ""}><strong>{failed}</strong><span>异常</span></div>
          <div><strong>{state.servers.reduce((count, server) => count + server.toolCount, 0)}</strong><span>工具</span></div>
        </div>
        <div className="config-actions mcp-server-actions">
          <button disabled={busyId !== null} onClick={() => void runAction("reload", reloadMcpServers, "已从文件重新加载 MCP 配置")} type="button">
            {busyId === "reload" ? <Loader2 className="spin" size={15} aria-hidden="true" /> : <RefreshCw size={15} aria-hidden="true" />}
            <span>从文件重载</span>
          </button>
          <button disabled={busyId !== null} onClick={openCreate} type="button">
            <Plus size={15} aria-hidden="true" />
            <span>添加服务</span>
          </button>
        </div>
      </section>

      <section className="config-section wide">
        <div className="mcp-server-list">
          {state.servers.length ? state.servers.map((server) => (
            <div className={`mcp-server-row status-${server.status}`} key={server.id}>
              <button
                aria-label={`${server.enabled ? "停用" : "启用"} ${server.name}`}
                aria-pressed={server.enabled}
                className={`mcp-server-toggle ${server.enabled ? "active" : ""}`}
                disabled={busyId !== null}
                onClick={() => toggleEnabled(server)}
                title={server.enabled ? "停用服务" : "启用服务"}
                type="button"
              >
                <span />
              </button>
              <div className="mcp-server-copy">
                <div className="mcp-server-title">
                  {server.status === "connected" ? <CheckCircle2 size={15} aria-hidden="true" /> : server.status === "disabled" ? <CircleOff size={15} aria-hidden="true" /> : <AlertTriangle size={15} aria-hidden="true" />}
                  <strong>{server.name}</strong>
                  <em>{transportLabel(server.transport)}</em>
                </div>
                <p>{server.transport === "stdio" ? [server.command, ...(server.args ?? [])].join(" ") : server.url}</p>
                <small>
                  {server.status === "connected" ? `${server.toolCount} 个工具` : server.status === "disabled" ? "已停用" : server.error}
                </small>
                {server.envKeys.length || server.headerNames.length ? (
                  <div className="mcp-secret-keys">
                    {[...server.envKeys, ...server.headerNames].map((key) => <span key={key}>{key}</span>)}
                  </div>
                ) : null}
              </div>
              <div className="mcp-server-row-actions">
                <button disabled={busyId !== null || !server.enabled} onClick={() => void runAction(server.id, () => reconnectMcpServer(server.id), `${server.name} 已重新连接`)} title="重新连接" type="button">
                  {busyId === server.id ? <Loader2 className="spin" size={15} aria-hidden="true" /> : <RefreshCw size={15} aria-hidden="true" />}
                </button>
                <button disabled={busyId !== null} onClick={() => openEdit(server)} title="编辑" type="button"><Pencil size={15} aria-hidden="true" /></button>
                <button className="danger" disabled={busyId !== null} onClick={() => remove(server)} title="删除" type="button"><Trash2 size={15} aria-hidden="true" /></button>
              </div>
            </div>
          )) : <p className="empty-state">暂无 MCP 服务</p>}
        </div>
      </section>

      {formOpen ? (
        <section className="config-section wide mcp-server-editor">
          <form onSubmit={submit}>
            <div className="mcp-server-editor-title">
              <h3>{form.id ? "编辑 MCP 服务" : "添加 MCP 服务"}</h3>
              <button onClick={closeForm} title="关闭" type="button"><X size={17} aria-hidden="true" /></button>
            </div>
            <div className="mcp-server-form-grid">
              <label>
                <span>名称</span>
                <input onChange={(event) => setForm({ ...form, name: event.target.value })} required type="text" value={form.name} />
              </label>
              <label>
                <span>传输方式</span>
                <select onChange={(event) => setForm({ ...form, transport: event.target.value as McpServerTransport })} value={form.transport}>
                  <option value="stdio">stdio</option>
                  <option value="streamable-http">Streamable HTTP</option>
                </select>
              </label>
              {form.transport === "stdio" ? (
                <>
                  <label>
                    <span>命令</span>
                    <input onChange={(event) => setForm({ ...form, command: event.target.value })} required type="text" value={form.command} />
                  </label>
                  <label>
                    <span>工作目录</span>
                    <input onChange={(event) => setForm({ ...form, cwd: event.target.value })} type="text" value={form.cwd} />
                  </label>
                  <label>
                    <span>参数</span>
                    <textarea onChange={(event) => setForm({ ...form, args: event.target.value })} value={form.args} />
                  </label>
                  <label>
                    <span>环境变量</span>
                    <textarea onChange={(event) => setForm({ ...form, env: event.target.value, envTouched: true })} placeholder={form.id ? "留空保留现有值" : "KEY=value"} value={form.env} />
                  </label>
                </>
              ) : (
                <>
                  <label className="mcp-server-form-wide">
                    <span>服务 URL</span>
                    <input onChange={(event) => setForm({ ...form, url: event.target.value })} required type="url" value={form.url} />
                  </label>
                  <label className="mcp-server-form-wide">
                    <span>请求头</span>
                    <textarea onChange={(event) => setForm({ ...form, headers: event.target.value, headersTouched: true })} placeholder={form.id ? "留空保留现有值" : "Authorization=Bearer ..."} value={form.headers} />
                  </label>
                </>
              )}
              <label className="mcp-server-enabled">
                <input checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} type="checkbox" />
                <span>启用服务</span>
              </label>
            </div>
            <div className="mcp-server-editor-actions">
              <button className="cancel" onClick={closeForm} type="button">取消</button>
              <button className="primary" disabled={busyId !== null} type="submit">
                {busyId !== null ? <Loader2 className="spin" size={15} aria-hidden="true" /> : <Save size={15} aria-hidden="true" />}
                <span>保存</span>
              </button>
            </div>
          </form>
        </section>
      ) : null}

      {error ? <div className="mcp-config-message error" role="alert"><AlertTriangle size={15} aria-hidden="true" /><span>{error}</span></div> : null}
      {success ? <div className="mcp-config-message success" role="status"><CheckCircle2 size={15} aria-hidden="true" /><span>{success}</span></div> : null}
    </div>
  );
}

function formInput(form: ServerForm): Partial<McpServerInput> {
  if (!form.name.trim()) {
    throw new Error("名称不能为空");
  }
  const input: Partial<McpServerInput> = {
    name: form.name.trim(),
    transport: form.transport,
    enabled: form.enabled
  };
  if (form.transport === "stdio") {
    if (!form.command.trim()) {
      throw new Error("stdio 服务必须配置命令");
    }
    input.command = form.command.trim();
    input.args = lines(form.args);
    input.cwd = form.cwd.trim();
    if (!form.id || form.envTouched) input.env = parsePairs(form.env, "环境变量");
  } else {
    if (!form.url.trim()) {
      throw new Error("HTTP 服务必须配置 URL");
    }
    input.url = form.url.trim();
    if (!form.id || form.headersTouched) input.headers = parsePairs(form.headers, "请求头");
  }
  return input;
}

function parsePairs(value: string, label: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of lines(value)) {
    const separator = line.indexOf("=");
    if (separator <= 0) {
      throw new Error(`${label}必须使用 KEY=value 格式`);
    }
    result[line.slice(0, separator).trim()] = line.slice(separator + 1);
  }
  return result;
}

function lines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function transportLabel(transport: McpServerTransport): string {
  return transport === "stdio" ? "stdio" : "HTTP";
}
