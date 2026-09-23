"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Database, FileText, LoaderCircle, Search, X } from "lucide-react";

import type { GoalSourceScope, GoalSourceScopeMode } from "@/lib/knowledge/types";
import WebSourceSearch from "./web-source-search";

type Props = {
  goalId: string;
  goalTitle: string;
  initialOpen?: boolean;
  onDismiss?: () => void;
  onSaved?: () => void;
};

function statusLabel(status: GoalSourceScope["sources"][number]["source"]["status"]) {
  if (status === "ready") return "可检索";
  if (status === "processing") return "处理中";
  if (status === "ocr_required") return "需要 OCR";
  return "处理失败";
}

export default function GoalSourceScopeButton({ goalId, goalTitle, initialOpen = false, onDismiss, onSaved }: Props) {
  const [open, setOpen] = useState(initialOpen);
  const [scope, setScope] = useState<GoalSourceScope | null>(null);
  const [mode, setMode] = useState<GoalSourceScopeMode>("auto");
  const [included, setIncluded] = useState<Set<string>>(new Set());
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");

  const activeCount = useMemo(() => {
    if (!scope) return 0;
    return scope.sources.filter((item) => mode === "auto" ? !excluded.has(item.source.id) : included.has(item.source.id)).length;
  }, [excluded, included, mode, scope]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/goals/${encodeURIComponent(goalId)}/sources`, { cache: "no-store" });
      const payload = await response.json() as { scope?: GoalSourceScope; error?: string };
      if (!response.ok || !payload.scope) throw new Error(payload.error || "读取资料范围失败。");
      setScope(payload.scope);
      setMode(payload.scope.mode);
      setIncluded(new Set(payload.scope.includedSourceIds));
      setExcluded(new Set(payload.scope.excludedSourceIds));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "读取资料范围失败。");
    } finally {
      setLoading(false);
    }
  }, [goalId]);

  useEffect(() => { if (initialOpen) void Promise.resolve().then(load); }, [initialOpen, load]);
  function dismiss() { if (importing || saving) return; setOpen(false); onDismiss?.(); }

  function openDialog() {
    setOpen(true);
    void load();
  }

  function changeMode(nextMode: GoalSourceScopeMode) {
    if (!scope || nextMode === mode) return;
    if (nextMode === "selected") {
      setIncluded(new Set(scope.sources.filter((item) => !excluded.has(item.source.id)).map((item) => item.source.id)));
    } else {
      setExcluded(new Set(scope.sources.filter((item) => !included.has(item.source.id)).map((item) => item.source.id)));
    }
    setMode(nextMode);
  }

  function toggleSource(sourceId: string) {
    if (mode === "auto") {
      setExcluded((current) => {
        const next = new Set(current);
        if (next.has(sourceId)) next.delete(sourceId);
        else next.add(sourceId);
        return next;
      });
    } else {
      setIncluded((current) => {
        const next = new Set(current);
        if (next.has(sourceId)) next.delete(sourceId);
        else next.add(sourceId);
        return next;
      });
    }
  }

  async function save() {
    if (importing) return;
    setSaving(true);
    setError("");
    try {
      const response = await fetch(`/api/goals/${encodeURIComponent(goalId)}/sources`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          includedSourceIds: mode === "selected" ? [...included] : [],
          excludedSourceIds: mode === "auto" ? [...excluded] : [],
        }),
      });
      const payload = await response.json() as { scope?: GoalSourceScope; error?: string };
      if (!response.ok || !payload.scope) throw new Error(payload.error || "保存资料范围失败。");
      setScope(payload.scope);
      setMode(payload.scope.mode);
      setIncluded(new Set(payload.scope.includedSourceIds));
      setExcluded(new Set(payload.scope.excludedSourceIds));
      setOpen(false);
      onSaved?.();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存资料范围失败。");
    } finally {
      setSaving(false);
    }
  }

  return <>
    {!initialOpen && <button className="goal-sources-button" type="button" onClick={openDialog}><Database size={12} /> 资料范围</button>}
    {open && typeof document !== "undefined" && createPortal(<div className="quick-log-overlay goal-source-overlay" role="dialog" aria-modal="true" aria-label={`${goalTitle}的学习资料`}>
      <button className="quick-log-backdrop" aria-label="资料选择背景" disabled={initialOpen || saving} onClick={dismiss} />
      <section className="quick-log-dialog goal-source-dialog" aria-busy={loading || saving}>
        <header className="goal-source-heading">
          <div><span className="eyebrow">KNOWLEDGE SCOPE</span><h2>{initialOpen ? "请选择教学资料，课程正在等待" : "这个目标使用哪些资料"}</h2><p>{goalTitle}</p></div>
          <button className="quiz-close-button" type="button" disabled={saving || importing} onClick={dismiss}><X size={14} /> {initialOpen ? "稍后选择" : "关闭"}</button>
        </header>
        <div className="goal-source-body">
        <div className="goal-source-mode" role="radiogroup" aria-label="资料范围模式">
          <button className={mode === "auto" ? "active" : ""} role="radio" aria-checked={mode === "auto"} onClick={() => changeMode("auto")}><Search size={14} /><span><strong>自动选择</strong><small>默认搜索全部可用资料，可排除不相关内容</small></span></button>
          <button className={mode === "selected" ? "active" : ""} role="radio" aria-checked={mode === "selected"} onClick={() => changeMode("selected")}><Check size={14} /><span><strong>仅指定资料</strong><small>课程和提问只允许使用勾选的资料</small></span></button>
        </div>
        <div className="goal-source-summary"><span>{mode === "auto" ? "自动范围" : "严格范围"}</span><strong>{activeCount} 份资料会参与检索</strong></div>
        <WebSourceSearch key={goalId} goalId={goalId} goalTitle={goalTitle} onBusyChange={setImporting} onImported={async (sourceId) => {
          const response = await fetch(`/api/goals/${encodeURIComponent(goalId)}/sources`, { cache: "no-store" });
          const payload = await response.json();
          if (!response.ok || !payload.scope) throw new Error("资料已收录，请重新打开资料范围查看。");
          setScope(payload.scope);
          setIncluded((current) => new Set([...current, sourceId]));
          setExcluded((current) => { const next = new Set(current); next.delete(sourceId); return next; });
        }} />
        <details className="goal-existing-sources">
        <summary>已有资料库 · {scope?.sources.length || 0} 份资料</summary>
        <p>这里是已入库资料，不是本轮联网搜索候选。是否参与本目标检索由上方资料范围决定。</p>
        {loading ? <div className="goal-source-empty"><LoaderCircle className="is-spinning" size={18} /> 正在读取资料库</div> : scope?.sources.length ? <div className="goal-source-list">
          {scope.sources.map((item) => {
            const checked = mode === "auto" ? !excluded.has(item.source.id) : included.has(item.source.id);
            const disabled = item.source.status !== "ready";
            return <label className={`goal-source-option${checked ? " is-checked" : ""}${disabled ? " is-disabled" : ""}`} key={item.source.id}>
              <input type="checkbox" checked={checked} disabled={disabled || saving} onChange={() => toggleSource(item.source.id)} />
              <span className="goal-source-check">{checked ? <Check size={12} /> : null}</span>
              <FileText size={15} />
              <span><strong>{item.source.title}</strong><small>{item.source.description || `${item.source.chunkCount} 个可检索片段`}</small></span>
              <em>{statusLabel(item.source.status)}</em>
            </label>;
          })}
        </div> : <div className="goal-source-empty"><Database size={18} /><strong>资料库还是空的</strong><span>先从计划页右上角的“个人资料库”上传资料。</span></div>}
        </details>
        {error && <p className="goal-source-error" role="alert">{error}</p>}
        </div>
        <footer className="goal-source-footer"><span>先勾选候选并点击「使用所选资料」，收录完成后再继续。</span><button className="primary-button" type="button" disabled={loading || saving || importing || activeCount === 0} onClick={() => void save()}>{saving ? <LoaderCircle className="is-spinning" size={14} /> : null}{saving ? "正在保存" : onSaved ? "保存并继续课程" : "保存资料范围"}</button></footer>
      </section>
    </div>, document.body)}
  </>;
}
