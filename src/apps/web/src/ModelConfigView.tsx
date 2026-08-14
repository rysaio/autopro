import {
  AlertTriangle,
  CheckCircle2,
  DatabaseZap,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Server,
  Trash2,
  X,
  Zap
} from "lucide-react";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { ModelConfigState, ModelConnectionSummary } from "@secops-agent/shared";
import {
  activateModelConnection,
  addModelConnection,
  fetchModelConfig,
  reloadModelConfig,
  removeModelConnection,
  updateModelConnection,
  type ModelConnectionInput
} from "./api.js";

/** 默认配置文件路径（可用环境变量 SECOPS_MODEL_CONFIG_PATH 覆盖）。 */
const MODEL_CONFIG_PATH_HINT = "runtime/config/model.json";

interface ModelConfigViewProps {
  /** 配置发生变化（增删改/激活/重载）后通知父组件刷新健康状态。 */
  onConfigChanged?: () => void;
}

interface ConnectionFormState {
  /** null = 新增；否则为正在编辑的连接 id。 */
  id: string | null;
  name: string;
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
}

const EMPTY_FORM: ConnectionFormState = {
  id: null,
  name: "",
  provider: "",
  model: "",
  baseUrl: "",
  apiKey: ""
};

export function ModelConfigView({ onConfigChanged }: ModelConfigViewProps) {
  const [state, setState] = useState<ModelConfigState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<ConnectionFormState>(EMPTY_FORM);

  useEffect(() => {
    let mounted = true;
    fetchModelConfig()
      .then((result) => {
        if (mounted) {
          setState(result);
        }
      })
      .catch((caught: unknown) => {
        if (mounted) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      })
      .finally(() => {
        if (mounted) {
          setLoading(false);
        }
      });
    return () => {
      mounted = false;
    };
  }, []);

  const active = state?.connections.find((connection) => connection.id === state.activeConnectionId) ?? null;
  const configured = Boolean(active && active.model.trim() && active.baseUrl.trim());

  function applyResult(result: ModelConfigState, message: string) {
    setState(result);
    setSuccess(message);
    setError(null);
    onConfigChanged?.();
  }

  async function runAction(
    id: string | null,
    action: () => Promise<ModelConfigState>,
    message: string
  ): Promise<void> {
    setBusyId(id);
    setError(null);
    setSuccess(null);
    try {
      applyResult(await action(), message);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyId(null);
    }
  }

  function openCreate() {
    setForm(EMPTY_FORM);
    setFormOpen(true);
    setError(null);
  }

  function openEdit(connection: ModelConnectionSummary) {
    setForm({
      id: connection.id,
      name: connection.name,
      provider: connection.provider,
      model: connection.model,
      baseUrl: connection.baseUrl,
      apiKey: ""
    });
    setFormOpen(true);
    setError(null);
  }

  function closeForm() {
    setFormOpen(false);
    setForm(EMPTY_FORM);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form.name.trim() || !form.provider.trim() || !form.model.trim() || !form.baseUrl.trim()) {
      setError("name / provider / model / baseUrl 均为必填字段");
      return;
    }
    const input: ModelConnectionInput = {
      name: form.name.trim(),
      provider: form.provider.trim(),
      model: form.model.trim(),
      baseUrl: form.baseUrl.trim(),
      apiKey: form.apiKey.trim()
    };
    const editingId = form.id;
    if (editingId) {
      await runAction(
        editingId,
        () => updateModelConnection(editingId, input),
        "连接已更新"
      );
    } else {
      await runAction(null, () => addModelConnection(input), "连接已添加");
    }
    setFormOpen(false);
    setForm(EMPTY_FORM);
  }

  function handleActivate(connection: ModelConnectionSummary) {
    runAction(
      connection.id,
      () => activateModelConnection(connection.id),
      `已切换活动连接：${connection.name}`
    );
  }

  function handleRemove(connection: ModelConnectionSummary) {
    if (!window.confirm(`确认删除模型连接「${connection.name}」？`)) {
      return;
    }
    runAction(
      connection.id,
      () => removeModelConnection(connection.id),
      `已删除连接：${connection.name}`
    );
  }

  function handleReload() {
    runAction(null, () => reloadModelConfig(), "已从文件重新加载 model.json");
  }

  return (
    <div className="config-grid model-config-grid">
      {/* 状态总览 + 启动前后加载入口 */}
      <section className="config-section model-config-overview">
        <div className="section-label">
          <Server size={14} aria-hidden="true" />
          <span>模型配置状态</span>
        </div>
        <div className="model-config-status">
          <div className={`model-config-badge ${configured ? "ok" : "warn"}`}>
            {configured
              ? <CheckCircle2 size={16} aria-hidden="true" />
              : <AlertTriangle size={16} aria-hidden="true" />}
            <strong>{configured ? "已配置" : "需要配置"}</strong>
          </div>
          <dl className="model-config-facts">
            <div>
              <dt>活动连接</dt>
              <dd>{active ? active.name : "未设置"}</dd>
            </div>
            <div>
              <dt>供应商 / 模型</dt>
              <dd>{active ? `${active.provider} / ${active.model}` : "—"}</dd>
            </div>
            <div>
              <dt>Base URL</dt>
              <dd>{active?.baseUrl || "—"}</dd>
            </div>
            <div>
              <dt>连接数</dt>
              <dd>{state?.connections.length ?? 0}</dd>
            </div>
          </dl>
        </div>

        <div className="config-actions model-config-actions" aria-label="模型配置操作">
          <button className="model-config-reload" disabled={busyId !== null} onClick={handleReload} type="button">
            {busyId === null ? <RefreshCw size={15} aria-hidden="true" /> : <Loader2 className="spin" size={15} aria-hidden="true" />}
            <span>从文件重载</span>
          </button>
          <button disabled={busyId !== null} onClick={openCreate} type="button">
            <Plus size={15} aria-hidden="true" />
            <span>新建连接</span>
          </button>
        </div>
      </section>

      {/* 连接列表 + 表单 */}
      <section className="config-section wide model-config-connections">
        <div className="section-label">
          <DatabaseZap size={14} aria-hidden="true" />
          <span>模型连接（{state?.connections.length ?? 0}）</span>
        </div>

        {loading ? (
          <p className="empty-state">
            <Loader2 className="spin" size={16} aria-hidden="true" /> 正在加载模型配置…
          </p>
        ) : error ? (
          <div className="model-config-error" role="alert">
            <AlertTriangle size={15} aria-hidden="true" />
            <span>{error}</span>
          </div>
        ) : !state?.connections.length ? (
          <p className="empty-state">
            尚未配置任何模型连接。点击「新建连接」添加，或编辑 {MODEL_CONFIG_PATH_HINT} 后点「从文件重载」。
          </p>
        ) : (
          <ul className="model-config-list">
            {state.connections.map((connection) => {
              const isActive = connection.id === state.activeConnectionId;
              const isBusy = busyId === connection.id;
              return (
                <li className={`model-config-row ${isActive ? "active" : ""}`} key={connection.id}>
                  <div className="model-config-row-main">
                    <div className="model-config-row-title">
                      <strong>{connection.name}</strong>
                      {isActive ? <em className="model-config-active-tag">活动</em> : null}
                    </div>
                    <p>{connection.provider} / {connection.model}</p>
                    <small>{connection.baseUrl} · API Key {connection.apiKeySet ? "已设置" : "未设置"}</small>
                  </div>
                  <div className="model-config-row-actions">
                    {!isActive ? (
                      <button
                        disabled={isBusy}
                        onClick={() => handleActivate(connection)}
                        title="设为活动连接"
                        type="button"
                      >
                        {isBusy ? <Loader2 className="spin" size={14} aria-hidden="true" /> : <Zap size={14} aria-hidden="true" />}
                        <span>启用</span>
                      </button>
                    ) : null}
                    <button disabled={isBusy} onClick={() => openEdit(connection)} title="编辑连接" type="button">
                      <Pencil size={14} aria-hidden="true" />
                      <span>编辑</span>
                    </button>
                    <button
                      className="danger"
                      disabled={isBusy}
                      onClick={() => handleRemove(connection)}
                      title="删除连接"
                      type="button"
                    >
                      <Trash2 size={14} aria-hidden="true" />
                      <span>删除</span>
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {formOpen ? (
          <form className="model-config-form" onSubmit={handleSubmit}>
            <div className="model-config-form-title">
              <h4>{form.id ? "编辑连接" : "新建连接"}</h4>
              <button className="model-config-form-close" onClick={closeForm} title="取消" type="button">
                <X size={15} aria-hidden="true" />
              </button>
            </div>
            <div className="model-config-form-grid">
              <label>
                <span>名称</span>
                <input
                  onChange={(event) => setForm({ ...form, name: event.target.value })}
                  placeholder="例如：deepseek 主连接"
                  type="text"
                  value={form.name}
                />
              </label>
              <label>
                <span>供应商</span>
                <input
                  onChange={(event) => setForm({ ...form, provider: event.target.value })}
                  placeholder="例如：deepseek / openai / qwen"
                  type="text"
                  value={form.provider}
                />
              </label>
              <label>
                <span>模型</span>
                <input
                  onChange={(event) => setForm({ ...form, model: event.target.value })}
                  placeholder="例如：deepseek-v4-flash"
                  type="text"
                  value={form.model}
                />
              </label>
              <label>
                <span>Base URL</span>
                <input
                  onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
                  placeholder="例如：https://api.deepseek.com"
                  type="text"
                  value={form.baseUrl}
                />
              </label>
              <label className="model-config-form-api-key">
                <span>API Key {form.id ? "（留空 = 保留原值）" : ""}</span>
                <input
                  onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
                  placeholder={form.id ? "输入以替换，留空保留" : "sk-..."}
                  type="password"
                  value={form.apiKey}
                />
              </label>
            </div>
            {error ? (
              <div className="model-config-error" role="alert">
                <AlertTriangle size={15} aria-hidden="true" />
                <span>{error}</span>
              </div>
            ) : null}
            {success ? (
              <div className="model-config-success" role="status">
                <CheckCircle2 size={15} aria-hidden="true" />
                <span>{success}</span>
              </div>
            ) : null}
            <div className="model-config-form-actions">
              <button className="cancel" onClick={closeForm} type="button">取消</button>
              <button className="primary" disabled={busyId !== null} type="submit">
                {busyId !== null ? <Loader2 className="spin" size={15} aria-hidden="true" /> : <Save size={15} aria-hidden="true" />}
                <span>保存</span>
              </button>
            </div>
          </form>
        ) : (
          success ? (
            <div className="model-config-success" role="status">
              <CheckCircle2 size={15} aria-hidden="true" />
              <span>{success}</span>
            </div>
          ) : null
        )}
      </section>
    </div>
  );
}
