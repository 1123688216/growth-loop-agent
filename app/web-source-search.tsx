"use client";
import { useEffect, useState } from "react";
import { LoaderCircle, Search } from "lucide-react";

type Candidate = { id: string; title: string; url: string; snippet: string };
export default function WebSourceSearch({ goalId, goalTitle, onImported, onBusyChange }: {
  goalId: string; goalTitle: string; onImported: (sourceId: string) => Promise<void>; onBusyChange?: (busy: boolean) => void;
}) {
  const [query, setQuery] = useState(goalTitle.slice(0, 500));
  const [requirements, setRequirements] = useState("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [outcomes, setOutcomes] = useState<Record<string, string>>({});
  const [imported, setImported] = useState<string[]>([]);
  const [busy, setBusy] = useState("");
  useEffect(() => { onBusyChange?.(!!busy); }, [busy, onBusyChange]);
  const [elapsed, setElapsed] = useState(0);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/web-sources?goalId=" + encodeURIComponent(goalId), { signal: controller.signal, cache: "no-store" })
      .then(async response => { const data = await response.json(); if (!response.ok) throw new Error(data.error); return data; })
      .then(data => { setCandidates(data.candidates || []); })
      .catch(reason => { if (!controller.signal.aborted) setError(reason.message || "读取候选失败"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [goalId]);
  useEffect(() => {
    if (!busy) return;
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [busy]);
  async function search() {
    setBusy("search"); setElapsed(0); setError(""); setMessage("");
    try {
      const response = await fetch("/api/web-sources", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "research", goalId, query, requirements }) });
      const result = await response.json();
      if (!response.ok || result.error) throw new Error(result.error || "搜索失败。");
      setCandidates(result.candidates || []); setSelected([]); setOutcomes({});
      setMessage("找到 " + (result.candidates || []).length + " 个候选。可多选，也可修改补充要求后换一批；结果可能重复。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "搜索失败。"); }
    finally { setBusy(""); }
  }
  async function importSelected() {
    const batch = candidates.filter(item => selected.includes(item.id) && !imported.includes(item.id));
    setError(""); setBusy("batch"); setElapsed(0); let success = 0; let partial = 0;
    try {
        const response = await fetch("/api/web-sources", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "import-batch", goalId, candidateIds: batch.map(item => item.id), description: requirements }) });
        if (!response.ok || !response.body) throw new Error("批次请求失败，请重试。");
        const reader = response.body.getReader(); const decoder = new TextDecoder(); let pending = ""; let done = false;
        try {
          while (true) {
            const part = await reader.read();
            pending += decoder.decode(part.value, {stream:!part.done});
            const lines = pending.split("\n"); pending = lines.pop() || "";
            for (const line of lines) {
              if (!line.trim()) continue;
              const result = JSON.parse(line);
              if (result.type === "error") throw new Error(result.error);
              if (result.type === "done") done = true;
              if (result.type === "progress") setMessage("正在处理 " + result.index + "/" + result.total + "：" + (batch.find(item => item.id === result.candidateId)?.title || ""));
              if (result.type === "item") {
                setOutcomes(current => ({...current,[result.candidateId]:result.ok ? result.message : "失败：" + result.error}));
                if (result.ok) {
                  if(result.partial) partial++;
                  else {
                    success++; setImported(current => [...current,result.candidateId]);
                    setSelected(current => current.filter(id => id !== result.candidateId));
                  }
                  try { for(const sourceId of result.sourceIds || [result.sourceId]) await onImported(sourceId); }
                  catch { setError("资料已收录，刷新资料范围失败，请重新打开查看。"); }
                }
              }
            }
            if (part.done) break;
          }
          if (!done) throw new Error("进度连接中断，服务端可能仍在处理；请稍后重新打开资料范围确认。");
        } finally { reader.releaseLock(); }
        setMessage("本次完整成功 " + success + "/" + batch.length + " 项，部分成功 " + partial + " 项。失败或部分成功项保留，可单独重试。保存资料范围后统一验证课程资料。");
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "批次处理失败。");
      } finally {
        setBusy("");
      }
  }
  return <details className="web-source-search" open>
    <summary>联网补充资料</summary>
    <p>先查看搜索摘要并多选，确认后才抓取正文、切片和向量化。摘要不是已核验的教学证据。</p>
    <p>自动补搜限一轮；你可以主动修改要求后继续换批。失败项可单独重试，不影响已成功资料。</p>
    <p>每次最多选择 3 个来源；普通来源抓 1 页，目录最多额外抓 2 个同域相关子页。每页独立限时 60 秒，不共享整批时间预算；解析与向量化另计。</p>
    <label>搜索内容<input value={query} maxLength={500} disabled={!!busy || loading} onChange={event => setQuery(event.target.value)} /></label>
    <label>补充要求 / 对上一批的不满意之处（可选）
      <textarea value={requirements} maxLength={1000} rows={3} disabled={!!busy || loading}
        placeholder="例如：我是初学者，希望中文、包含完整示例；上一批偏面试题，想换成系统教程，优先可直接访问的网站。"
        onChange={event => setRequirements(event.target.value)} />
    </label>
    <button type="button" className="primary-button" disabled={!!busy || loading || !query.trim()} onClick={() => void search()}>
      <Search size={14} /> {candidates.length ? "按补充要求换一批" : "搜索资料摘要"}
    </button>
    {busy && <p role="status"><LoaderCircle className="is-spinning" size={16} /> {busy === "search" ? "正在搜索摘要（尚未抓取正文）" : "正在抓取正文、解析并建立索引"} · 已用时 {elapsed} 秒</p>}
    {message && <p role="status">{message}</p>}
    {error && <p className="goal-source-error" role="alert">{error}</p>}
    {candidates.map(item => <section key={item.id}>
      <label><input type="checkbox" disabled={!!busy || imported.includes(item.id) || (selected.length >= 3 && !selected.includes(item.id))} checked={selected.includes(item.id)}
        onChange={event => setSelected(current => event.target.checked ? [...current, item.id] : current.filter(id => id !== item.id))} />
        {item.title}</label>
      <a href={item.url} target="_blank" rel="noopener noreferrer">{new URL(item.url).hostname} · 查看原文</a>
      <p>{item.snippet || "搜索接口未返回摘要，可先查看原文。"}</p>
      {outcomes[item.id] && <p role="status">{outcomes[item.id]}</p>}
    </section>)}
    {!!candidates.length && <button type="button" className="primary-button" disabled={!!busy || !selected.length} onClick={() => void importSelected()}>
      使用所选资料（{selected.length}）
    </button>}
  </details>;
}
