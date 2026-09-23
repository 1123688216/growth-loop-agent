"use client";

import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  ChevronLeft,
  ChevronRight,
  Database,
  FileText,
  Layers3,
  LoaderCircle,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import type {
  KnowledgeSourceChunk,
  KnowledgeSourceChunkPage,
  KnowledgeSourceChunkSet,
  KnowledgeSourceSummary,
} from "@/lib/knowledge/types";

type AddMode = "file" | "text";

function formatBytes(value: number) {
  if (value < 1_024) return `${value} B`;
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / 1_024 / 1_024).toFixed(1)} MB`;
}

function sourceKindLabel(kind: KnowledgeSourceSummary["kind"]) {
  return ({ text: "文本", txt: "TXT", pdf: "PDF", docx: "DOCX" })[kind];
}

function statusCopy(source: KnowledgeSourceSummary) {
  if (source.status === "ready") {
    return source.parentChunkCount > 0
      ? `${source.chunkCount} 个子片段 · ${source.parentChunkCount} 个父片段`
      : `${source.chunkCount} 个可检索片段`;
  }
  if (source.status === "ocr_required") return "扫描件，需要 OCR 后才能检索";
  if (source.status === "failed") return source.errorMessage || "解析失败";
  return "正在处理";
}

function strategyCopy(strategy: string) {
  if (strategy === "llamaindex-hierarchical-parent-child") return "结构解析 + LlamaIndex 父子";
  if (strategy === "structure-recursive-parent-child") return "结构 + 递归 + 父子";
  if (strategy === "legacy-character") return "旧版字符切片";
  return strategy || "未建立切片";
}

function pageCopy(chunk: KnowledgeSourceChunk) {
  if (chunk.pageStart === null) return "无页码信息";
  if (chunk.pageEnd === null || chunk.pageEnd === chunk.pageStart) return `第 ${chunk.pageStart} 页`;
  return `第 ${chunk.pageStart}–${chunk.pageEnd} 页`;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function HighlightedText({ text, query }: { text: string; query: string }) {
  if (!query) return text;
  const parts = text.split(new RegExp(`(${escapeRegExp(query)})`, "gi"));
  return <>{parts.map((part, index) => part.toLocaleLowerCase() === query.toLocaleLowerCase()
    ? <mark key={`${part}-${index}`}>{part}</mark>
    : part)}</>;
}

export default function SourceLibrary() {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<AddMode>("file");
  const [sources, setSources] = useState<KnowledgeSourceSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [chunkSource, setChunkSource] = useState<KnowledgeSourceSummary | null>(null);
  const [chunks, setChunks] = useState<KnowledgeSourceChunk[]>([]);
  const [chunkTotal, setChunkTotal] = useState(0);
  const [chunkSet, setChunkSet] = useState<KnowledgeSourceChunkSet | null>(null);
  const [chunkLoading, setChunkLoading] = useState(false);
  const [rechunking, setRechunking] = useState(false);
  const [chunkError, setChunkError] = useState("");
  const [selectedChunkId, setSelectedChunkId] = useState("");
  const [chunkSearchDraft, setChunkSearchDraft] = useState("");
  const [chunkQuery, setChunkQuery] = useState("");
  const [showParentChunk, setShowParentChunk] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const chunkDialogRef = useRef<HTMLElement>(null);
  const chunkRequestRef = useRef(0);

  const activeChunk = chunks.find((chunk) => chunk.id === selectedChunkId) || chunks[0] || null;
  const activeChunkIndex = activeChunk ? chunks.findIndex((chunk) => chunk.id === activeChunk.id) : -1;

  useEffect(() => {
    if (!chunkSource) return;
    chunkDialogRef.current?.focus();
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        closeChunkViewer();
        return;
      }
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (event.key === "ArrowLeft" && activeChunkIndex > 0) {
        event.preventDefault();
        setSelectedChunkId(chunks[activeChunkIndex - 1].id);
      }
      if (event.key === "ArrowRight" && activeChunkIndex >= 0 && activeChunkIndex < chunks.length - 1) {
        event.preventDefault();
        setSelectedChunkId(chunks[activeChunkIndex + 1].id);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeChunkIndex, chunkSource, chunks]);

  async function openLibrary() {
    setOpen(true);
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/knowledge-sources", { cache: "no-store" });
      const payload = await response.json() as { sources?: KnowledgeSourceSummary[]; error?: string };
      if (!response.ok) throw new Error(payload.error || "资料库读取失败。");
      setSources(payload.sources || []);
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : "资料库读取失败。");
    } finally {
      setLoading(false);
    }
  }

  function closeLibrary() {
    chunkRequestRef.current += 1;
    setChunkSource(null);
    setOpen(false);
  }

  function closeChunkViewer() {
    chunkRequestRef.current += 1;
    setChunkSource(null);
    setChunks([]);
    setChunkTotal(0);
    setChunkSet(null);
    setChunkLoading(false);
    setRechunking(false);
    setChunkError("");
    setSelectedChunkId("");
    setChunkSearchDraft("");
    setChunkQuery("");
    setShowParentChunk(false);
  }

  async function loadChunkPage(source: KnowledgeSourceSummary, query: string, offset: number, append: boolean) {
    const requestId = ++chunkRequestRef.current;
    setChunkLoading(true);
    setChunkError("");
    try {
      const parameters = new URLSearchParams({ offset: String(offset), limit: "50" });
      if (query) parameters.set("query", query);
      const response = await fetch(`/api/knowledge-sources/${encodeURIComponent(source.id)}/chunks?${parameters}`, { cache: "no-store" });
      const payload = await response.json() as Partial<KnowledgeSourceChunkPage> & { error?: string };
      if (!response.ok || !payload.source || !payload.chunks || typeof payload.total !== "number") {
        throw new Error(payload.error || "切片读取失败。");
      }
      if (requestId !== chunkRequestRef.current) return;
      setChunkSource(payload.source);
      setChunkSet(payload.chunkSet || null);
      setChunkTotal(payload.total);
      setChunks((current) => append ? [...current, ...payload.chunks!] : payload.chunks!);
      if (!append) setSelectedChunkId(payload.chunks[0]?.id || "");
    } catch (fetchError) {
      if (requestId !== chunkRequestRef.current) return;
      setChunkError(fetchError instanceof Error ? fetchError.message : "切片读取失败。");
      if (!append) {
        setChunks([]);
        setChunkTotal(0);
        setSelectedChunkId("");
      }
    } finally {
      if (requestId === chunkRequestRef.current) setChunkLoading(false);
    }
  }

  function openChunkViewer(source: KnowledgeSourceSummary) {
    setChunkSource(source);
    setChunks([]);
    setChunkTotal(source.chunkCount);
    setChunkSet(null);
    setSelectedChunkId("");
    setChunkSearchDraft("");
    setChunkQuery("");
    setShowParentChunk(false);
    void loadChunkPage(source, "", 0, false);
  }

  async function rechunkSource() {
    if (!chunkSource || rechunking || chunkLoading) return;
    setRechunking(true);
    setChunkError("");
    try {
      const response = await fetch(`/api/knowledge-sources/${encodeURIComponent(chunkSource.id)}/rechunk`, { method: "POST" });
      const payload = await response.json() as { source?: KnowledgeSourceSummary; error?: string };
      if (!response.ok || !payload.source) throw new Error(payload.error || "重新切片失败。");
      const updated = payload.source;
      setSources((current) => current.map((source) => source.id === updated.id ? updated : source));
      setChunkSource(updated);
      setChunkSearchDraft("");
      setChunkQuery("");
      setShowParentChunk(false);
      await loadChunkPage(updated, "", 0, false);
    } catch (rechunkError) {
      setChunkError(rechunkError instanceof Error ? rechunkError.message : "重新切片失败。");
    } finally {
      setRechunking(false);
    }
  }

  function searchChunks(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!chunkSource || chunkLoading) return;
    const query = chunkSearchDraft.trim();
    setChunkQuery(query);
    void loadChunkPage(chunkSource, query, 0, false);
  }

  function clearChunkSearch() {
    setChunkSearchDraft("");
    if (!chunkSource || !chunkQuery || chunkLoading) return;
    setChunkQuery("");
    void loadChunkPage(chunkSource, "", 0, false);
  }

  function resetDraft() {
    setTitle("");
    setDescription("");
    setText("");
    setFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function addSource() {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      let response: Response;
      if (mode === "file") {
        if (!file) throw new Error("请先选择文件。");
        const body = new FormData();
        body.set("file", file);
        if (title.trim()) body.set("title", title.trim());
        if (description.trim()) body.set("description", description.trim());
        response = await fetch("/api/knowledge-sources", { method: "POST", body });
      } else {
        if (!title.trim()) throw new Error("请填写资料名称。");
        if (!text.trim()) throw new Error("请粘贴资料内容。");
        response = await fetch("/api/knowledge-sources", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: title.trim(), description: description.trim(), text: text.trim() }),
        });
      }
      const payload = await response.json() as { source?: KnowledgeSourceSummary; error?: string };
      if (!response.ok || !payload.source) throw new Error(payload.error || "资料处理失败。");
      setSources((current) => [payload.source!, ...current]);
      resetDraft();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "资料处理失败。");
    } finally {
      setSaving(false);
    }
  }

  async function removeSource(sourceId: string) {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const response = await fetch(`/api/knowledge-sources/${encodeURIComponent(sourceId)}`, { method: "DELETE" });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || "资料删除失败。");
      setSources((current) => current.filter((source) => source.id !== sourceId));
      setDeleteId(null);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "资料删除失败。");
    } finally {
      setSaving(false);
    }
  }

  return <>
    <button className="quiet-button source-library-trigger" onClick={() => void openLibrary()}><Database size={14} /> 个人资料库</button>
    {open && <div className="quick-log-overlay source-library-overlay" role="dialog" aria-modal="true" aria-label="个人资料库">
      <button className="quick-log-backdrop" aria-label="关闭个人资料库" disabled={saving} onClick={closeLibrary} />
      <section className="quick-log-dialog source-library-dialog" aria-busy={saving}>
        <div className="quick-log-heading source-library-heading">
          <div><span className="eyebrow">PERSONAL SOURCES</span><h2>个人资料库</h2><p>先把可信资料整理成可检索片段；后续由导师和规划师通过 Tool 按需调用。</p></div>
          <button className="quiz-close-button" disabled={saving} onClick={closeLibrary}><X size={15} /> 关闭</button>
        </div>

        <div className="source-library-layout">
          <div className="source-add-panel">
            <div className="plan-view-switch source-mode-switch"><button className={mode === "file" ? "active" : ""} onClick={() => { setMode("file"); setError(""); }}>上传文件</button><button className={mode === "text" ? "active" : ""} onClick={() => { setMode("text"); setError(""); }}>粘贴文本</button></div>
            <label className="learning-field"><span>资料名称{mode === "file" && "（可选）"}</span><input value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} placeholder={mode === "file" ? "留空时使用文件名" : "例如：LangGraph 官方教程笔记"} /></label>
            <label className="learning-field"><span>资料说明（推荐填写）</span><textarea value={description} maxLength={1_000} rows={3} onChange={(event) => setDescription(event.target.value)} placeholder="这是什么资料？你希望用它学习什么？哪些章节或主题最重要？" /><small>后续检索 Tool 会把这段说明用于资料筛选和教学上下文组装。</small></label>
            {mode === "file" ? <div className="source-file-picker">
              <input ref={fileInputRef} type="file" accept=".txt,.pdf,.docx,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={(event) => setFile(event.target.files?.[0] || null)} />
              <Upload size={18} /><strong>{file ? file.name : "选择 TXT / PDF / DOCX"}</strong><span>{file ? formatBytes(file.size) : "不设固定文件大小上限；大文件处理会更久，扫描 PDF 暂不支持 OCR"}</span>
            </div> : <label className="learning-field source-text-field"><span>资料正文</span><textarea value={text} rows={8} onChange={(event) => setText(event.target.value)} placeholder="粘贴课程笔记、官方文档片段或你整理过的文本……" /></label>}
            {error && <div className="source-library-error"><AlertCircle size={13} /><span>{error}</span></div>}
            <button className="primary-button source-add-button" disabled={saving || (mode === "file" ? !file : !title.trim() || !text.trim())} onClick={() => void addSource()}>{saving ? <LoaderCircle className="is-spinning" size={14} /> : <Database size={14} />}{saving ? "正在解析并建立索引" : "加入资料库"}</button>
            <small className="source-privacy-note">资料按当前账号隔离。此处上传仍走原有解析链路；RAGFlow 资料在 RAGFlow 中管理，绑定后可用于课程与答疑。</small>
          </div>

          <div className="source-list-panel">
            <div className="source-list-heading"><div><span className="eyebrow">INDEXED SOURCES</span><strong>已上传资料</strong></div><span>{sources.length} 份</span></div>
            {loading ? <div className="source-list-state"><LoaderCircle className="is-spinning" size={18} /><span>正在读取资料库</span></div> : sources.length === 0 ? <div className="source-list-state"><FileText size={20} /><strong>资料库还是空的</strong><span>先上传一份你信任的资料。</span></div> : <div className="source-list">
              {sources.map((source) => <article className={`source-row is-${source.status}`} key={source.id}>
                <div className="source-row-icon">{source.status === "ready" ? <Check size={14} /> : source.status === "processing" ? <LoaderCircle className="is-spinning" size={14} /> : <AlertCircle size={14} />}</div>
                <div className="source-row-copy"><strong>{source.title}</strong>{source.description && <p>{source.description}</p>}<span>{sourceKindLabel(source.kind)} · {formatBytes(source.byteSize)} · {source.charCount.toLocaleString()} 字符</span><small>{statusCopy(source)}</small>{source.chunkStrategy && <small className="source-strategy">{strategyCopy(source.chunkStrategy)}</small>}{source.warningMessage && <small className="source-warning">{source.warningMessage}</small>}</div>
                {deleteId === source.id ? <div className="source-delete-confirm"><span>确认删除？</span><button disabled={saving} onClick={() => setDeleteId(null)}>取消</button><button disabled={saving} onClick={() => void removeSource(source.id)}>删除</button></div> : <div className="source-row-actions">
                  {source.status === "ready" && source.chunkCount > 0 && <button className="source-chunks-button" onClick={() => openChunkViewer(source)}><Layers3 size={12} /> 查看切片</button>}
                  <button className="source-delete-button" aria-label={`删除资料 ${source.title}`} disabled={saving} onClick={() => setDeleteId(source.id)}><Trash2 size={13} /></button>
                </div>}
              </article>)}
            </div>}
          </div>
        </div>
      </section>
    </div>}
    {chunkSource && <div className="quick-log-overlay source-chunk-overlay" role="dialog" aria-modal="true" aria-label={`${chunkSource.title}的切片`}>
      <button className="quick-log-backdrop" aria-label="关闭切片查看器" onClick={closeChunkViewer} />
      <section ref={chunkDialogRef} className="quick-log-dialog source-chunk-dialog" tabIndex={-1} aria-busy={chunkLoading}>
        <header className="source-chunk-header">
          <div><span className="eyebrow">SOURCE CHUNKS</span><h2>{chunkSource.title}</h2><p>{chunkSet?.strategy === 'ragflow' ? `RAGFlow 原始片段快照 · ${chunkSet.childCount} 个片段（不在本项目重新切片）` : chunkSet ? `${strategyCopy(chunkSet.strategy)} · ${chunkSet.parentCount} 个父片段 / ${chunkSet.childCount} 个子片段` : "检查系统实际保存并参与检索的文本片段。"}</p></div>
          <div className="source-chunk-header-actions">
            {chunkSet?.strategy !== 'ragflow' && <button className="quiet-button source-rechunk-button" disabled={rechunking || chunkLoading} onClick={() => void rechunkSource()}>{rechunking ? <LoaderCircle className="is-spinning" size={13} /> : <RefreshCw size={13} />}{rechunking ? "正在优化" : "优化切片"}</button>}
            <button className="quiz-close-button" disabled={rechunking} onClick={closeChunkViewer}><X size={15} /> 关闭</button>
          </div>
        </header>

        <form className="source-chunk-search" role="search" onSubmit={searchChunks}>
          <Search size={14} aria-hidden="true" />
          <label className="sr-only" htmlFor="source-chunk-query">搜索当前资料的切片</label>
          <input id="source-chunk-query" value={chunkSearchDraft} maxLength={120} onChange={(event) => setChunkSearchDraft(event.target.value)} placeholder="搜索片段内容或标题" />
          {chunkSearchDraft && <button type="button" aria-label="清空搜索并显示全部片段" onClick={clearChunkSearch}><X size={12} /></button>}
          <button className="source-chunk-search-submit" type="submit" disabled={chunkLoading}>搜索</button>
        </form>

        <div className="source-chunk-layout">
          <aside className="source-chunk-index" aria-label="切片列表">
            <div className="source-chunk-index-heading"><strong>{chunkQuery ? "搜索结果" : "全部片段"}</strong><span>{chunkTotal} 个</span></div>
            {chunkLoading && chunks.length === 0 ? <div className="source-chunk-state" aria-live="polite"><LoaderCircle className="is-spinning" size={17} /><span>正在读取切片</span></div> : chunkError && chunks.length === 0 ? <div className="source-chunk-state is-error"><AlertCircle size={17} /><span>{chunkError}</span><button onClick={() => void loadChunkPage(chunkSource, chunkQuery, 0, false)}>重试</button></div> : chunks.length === 0 ? <div className="source-chunk-state"><Search size={17} /><span>{chunkQuery ? "没有匹配的片段" : "这份资料没有可查看的片段"}</span></div> : <div className="source-chunk-index-list">
              {chunks.map((chunk) => <button className={activeChunk?.id === chunk.id ? "active" : ""} key={chunk.id} onClick={() => setSelectedChunkId(chunk.id)}>
                <span>{String(chunk.position + 1).padStart(2, "0")}</span>
                <div><strong><HighlightedText text={chunk.heading || `片段 ${chunk.position + 1}`} query={chunkQuery} /></strong><p><HighlightedText text={chunk.content.replace(/\s+/g, " ").slice(0, 76)} query={chunkQuery} /></p></div>
              </button>)}
              {chunks.length < chunkTotal && <button className="source-chunk-load-more" disabled={chunkLoading} onClick={() => void loadChunkPage(chunkSource, chunkQuery, chunks.length, true)}>{chunkLoading ? <LoaderCircle className="is-spinning" size={13} /> : null}{chunkLoading ? "正在加载" : `继续加载（${chunks.length}/${chunkTotal}）`}</button>}
            </div>}
          </aside>

          <article className="source-chunk-reader" aria-live="polite">
            {activeChunk ? <>
              <div className="source-chunk-reader-heading">
                <div><span>{chunkSet?.strategy === 'ragflow' ? `CHUNK ${activeChunk.position + 1}` : showParentChunk ? `PARENT ${String(activeChunk.parentPosition + 1).padStart(2, "0")}` : `CHILD ${String(activeChunk.position + 1).padStart(2, "0")}`}</span><h3><HighlightedText text={(showParentChunk ? activeChunk.parentHeading : activeChunk.heading) || `片段 ${activeChunk.position + 1}`} query={chunkQuery} /></h3>{activeChunk.sectionPath.length > 0 && <p className="source-chunk-breadcrumb">{activeChunk.sectionPath.join(" / ")}</p>}</div>
                <div className="source-chunk-reader-tools">
                  {chunkSet?.strategy !== 'ragflow' && <div className="source-chunk-view-switch" aria-label="父子片段视图"><button className={!showParentChunk ? "active" : ""} aria-pressed={!showParentChunk} onClick={() => setShowParentChunk(false)}>子片段</button><button className={showParentChunk ? "active" : ""} aria-pressed={showParentChunk} onClick={() => setShowParentChunk(true)}>父片段</button></div>}
                  <div className="source-chunk-nav"><button aria-label="上一个片段" disabled={activeChunkIndex <= 0} onClick={() => setSelectedChunkId(chunks[activeChunkIndex - 1]?.id || activeChunk.id)}><ChevronLeft size={14} /></button><button aria-label="下一个片段" disabled={activeChunkIndex < 0 || activeChunkIndex >= chunks.length - 1} onClick={() => setSelectedChunkId(chunks[activeChunkIndex + 1]?.id || activeChunk.id)}><ChevronRight size={14} /></button></div>
                </div>
              </div>
              <div className="source-chunk-meta"><span>{pageCopy(activeChunk)}</span><span>字符 {activeChunk.charStart.toLocaleString()}–{activeChunk.charEnd.toLocaleString()}</span><span>约 {(showParentChunk ? activeChunk.parentTokenEstimate : activeChunk.tokenEstimate).toLocaleString()} tokens</span><span>{String(activeChunk.boundaryReason.method || "structure")}</span></div>
              <div className={`source-chunk-content${showParentChunk ? " is-parent" : ""}`}><HighlightedText text={showParentChunk ? activeChunk.parentContent : activeChunk.content} query={chunkQuery} /></div>
              {chunkSet?.strategy === 'ragflow' ? <p>向量化输入由 RAGFlow 与知识库模型配置决定；此处仅展示原始片段，不代表完整模型输入。</p> : !showParentChunk && <details><summary>查看向量化输入（上下文前缀 + 子片段）</summary><div className="source-chunk-content"><HighlightedText text={[activeChunk.contextPrefix.trim(), activeChunk.content.trim()].filter(Boolean).join("\n\n")} query={chunkQuery} /></div></details>}
            </> : <div className="source-chunk-reader-empty"><FileText size={20} /><span>选择一个片段查看正文</span></div>}
          </article>
        </div>
        {chunkError && chunks.length > 0 && <div className="source-chunk-inline-error"><AlertCircle size={12} />{chunkError}</div>}
        <footer className="source-chunk-footer"><span>{chunkSet?.strategy === 'ragflow' ? '← / → 切换片段；解析与向量化请在 RAGFlow 中管理' : '← / → 可切换子片段；命中子片段后可展开父片段补足上下文'}</span><span>每次最多读取 50 个片段</span></footer>
      </section>
    </div>}
  </>;
}
