import { AlertTriangle, FileText, Loader2, RefreshCw, Sparkles } from "lucide-react";
import { useState } from "react";
import type { SkillContent, SkillSummary } from "@secops-agent/shared";
import { fetchSkillContent } from "./api.js";

interface SkillViewProps {
  skills: SkillSummary[];
  onReload: () => Promise<SkillSummary[]>;
  onToggleSkill: (id: string, enabled: boolean) => void;
}

export function SkillView({ skills, onReload, onToggleSkill }: SkillViewProps) {
  const [selected, setSelected] = useState<SkillContent | null>(null);
  const [busy, setBusy] = useState<"reload" | string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loaded = skills.filter((skill) => skill.status === "loaded").length;
  const failed = skills.length - loaded;

  async function reload() {
    setBusy("reload");
    setError(null);
    try {
      const next = await onReload();
      if (selected) {
        const current = next.find((skill) => skill.id === selected.id && skill.status === "loaded");
        setSelected(current ? await fetchSkillContent(current.id) : null);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  }

  async function openSkill(skill: SkillSummary) {
    if (skill.status !== "loaded") return;
    setBusy(skill.id);
    setError(null);
    try {
      setSelected(await fetchSkillContent(skill.id));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="catalog-workspace skill-workspace">
      <section className="config-section wide catalog-overview">
        <div className="section-label"><Sparkles size={14} aria-hidden="true" /><span>技能目录</span></div>
        <div className="catalog-facts">
          <div><strong>{skills.length}</strong><span>技能</span></div>
          <div><strong>{loaded}</strong><span>已加载</span></div>
          <div className={failed ? "warn" : ""}><strong>{failed}</strong><span>异常</span></div>
        </div>
        <div className="config-actions">
          <button className="catalog-reload-button" disabled={busy !== null} onClick={() => void reload()} type="button">
            {busy === "reload" ? <Loader2 className="spin" size={15} aria-hidden="true" /> : <RefreshCw size={15} aria-hidden="true" />}
            <span>重新加载技能</span>
          </button>
        </div>
      </section>

      <section className="config-section skill-section">
        <div className="section-label"><FileText size={14} aria-hidden="true" /><span>技能</span></div>
        <div className="skill-list">
          {skills.length ? skills.map((skill) => (
            <div className={`skill-row status-${skill.status} ${selected?.id === skill.id ? "active" : ""}`} key={skill.id}>
              <button className="skill-open" disabled={busy !== null || skill.status !== "loaded"} onClick={() => void openSkill(skill)} type="button">
                {busy === skill.id ? <Loader2 className="spin" size={14} aria-hidden="true" /> : skill.status === "loaded" ? <FileText size={14} aria-hidden="true" /> : <AlertTriangle size={14} aria-hidden="true" />}
                <span>
                  <strong>{skill.name}</strong>
                  <small>{skill.status === "loaded" ? skill.description : skill.error}</small>
                  <em>{skill.source === "plugin" ? `插件 · ${skill.pluginId}` : "独立技能"}</em>
                </span>
              </button>
              <label className="toggle" title={skill.enabled ? "点击禁用该技能（对模型不可见）" : "点击启用该技能"}>
                <input
                  aria-label={`启用技能 ${skill.name}`}
                  checked={skill.enabled}
                  disabled={skill.status !== "loaded"}
                  onChange={() => onToggleSkill(skill.id, !skill.enabled)}
                  type="checkbox"
                />
                <span className="toggle-track" aria-hidden="true" />
              </label>
            </div>
          )) : <p className="empty-state">暂无技能</p>}
        </div>
      </section>

      <section className="config-section skill-content-section">
        <div className="section-label"><FileText size={14} aria-hidden="true" /><span>{selected?.name ?? "技能正文"}</span></div>
        {selected ? <div className="skill-content"><small>{selected.id}</small><pre>{selected.content}</pre></div> : <p className="empty-state">未选择技能</p>}
      </section>
      {error ? <div className="mcp-config-message error" role="alert"><AlertTriangle size={15} aria-hidden="true" /><span>{error}</span></div> : null}
    </div>
  );
}
