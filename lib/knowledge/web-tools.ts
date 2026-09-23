import { randomUUID } from "node:crypto";
import { configuredEmbeddingModel } from './embedding-config.ts';
import { getDatabase, withTransaction } from "../db/index.ts";
import { createKnowledgeSource } from "../db/knowledge-sources.ts";
import { vectorizeKnowledgeSource } from "../db/embeddings.ts";
import { beginPipelineRun, completePipelineRun, failPipelineRun, recordPipelineStage } from "../db/pipeline-metrics.ts";
import { ingestKnowledgeSource } from "./ingestion.ts";
import { extractWeb, searchWeb, webSearchProvider, WebSourceError } from "./web-provider.ts";
import { WEB_LIMITS, deadline } from "./web-timeouts.ts";
import { reviewWebPage } from "./page-review.ts";
import { rankDirectoryLinks } from './directory-links.ts';
import { webPageReviewEnabled } from './web-policy.ts';

// Injected by trusted server entry points, never read from a model/browser payload.
type Context = { userId: string; goalId: string; knowledgeGateId?:string; trigger?:'user'|'agent'; onProgress?:(message:string)=>Promise<void> };
export async function importWebBatch(context: Context, ids: unknown, description: string,
  report: (event: Record<string, unknown>) => void) {
  checkGoal(context);
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > WEB_LIMITS.batchSize ||
    ids.some(id => typeof id !== "string" || !id || id.length > 200) || new Set(ids).size !== ids.length) {
    throw new WebSourceError("每批请选择 1–3 个不同来源。");
  }
  // Validate the entire selection before executing any side effects.
  for (const id of ids) {
    if (!getDatabase().prepare("SELECT id FROM web_search_candidates WHERE id=? AND user_id=? AND goal_id=?")
      .get(id, context.userId, context.goalId)) throw new WebSourceError("候选不属于当前目标。", 404);
  }
  for (const [index, id] of ids.entries()) {
    report({type:"progress",candidateId:id,index:index+1,total:ids.length});
    try {
      const result = await ingestWebTool({...context,trigger:'user'}, id, description);
      report({type:"item",candidateId:id,ok:true,...result});
    } catch (error) {
      report({type:"item",candidateId:id,ok:false,error:error instanceof WebSourceError ? error.message : "资料处理失败，请重试。"});
    }
  }
  report({type:"done"});
}

function checkGoal(context: Context) {
  if (!getDatabase().prepare("SELECT id FROM goals WHERE id = ? AND user_id = ?").get(context.goalId, context.userId)) {
    throw new WebSourceError("找不到这个学习目标。", 404);
  }
  if(context.knowledgeGateId && !getDatabase().prepare('SELECT id FROM knowledge_gates WHERE id=? AND user_id=? AND goal_id=?')
    .get(context.knowledgeGateId,context.userId,context.goalId)) throw new WebSourceError('知识缺口不属于当前目标。',404);
}

export async function searchWebTool(context: Context, query: string) {
  checkGoal(context);
  query = query.trim();
  if (!query || query.length > 500) throw new WebSourceError("请输入 1–500 字的搜索内容。");
  const run = beginPipelineRun({ userId: context.userId, operation: "retrieval", config: { goalId: context.goalId, purpose: "web_search", query } });
  try {
    const candidates = (await searchWeb(query)).map((item) => ({ ...item, id: randomUUID() }));
    withTransaction((db) => {
      const insert = db.prepare("INSERT INTO web_search_candidates (id, user_id, goal_id, query, title, url, snippet, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
      for (const item of candidates) insert.run(item.id, context.userId, context.goalId, query, item.title, item.url, item.snippet, new Date().toISOString());
      if(context.knowledgeGateId) for(const item of candidates) db.prepare('INSERT OR IGNORE INTO knowledge_gate_candidates(gate_id,candidate_id) VALUES(?,?)')
        .run(context.knowledgeGateId,item.id);
    });
    recordPipelineStage({ pipelineRunId: run.id, stage: "web_search", wallDurationMs: performance.now() - run.startedMonotonicMs, outputCount: candidates.length, provider: webSearchProvider() });
    completePipelineRun(run.id, run.startedMonotonicMs);
    return { candidates, durationMs: Math.round(performance.now() - run.startedMonotonicMs) };
  } catch (error) {
    failPipelineRun({ id: run.id, startedMonotonicMs: run.startedMonotonicMs, errorCode: "web_search_failed", errorMessage: error instanceof Error ? error.message : "搜索失败" });
    throw error;
  }
}

type ImportResult = {sourceId:string;sourceIds?:string[];partial?:boolean;reused:boolean;embeddingStatus:string;durationMs:number;message:string};
export async function ingestWebTool(context: Context, candidateId: string, description: string, childPage=false): Promise<ImportResult> {
  checkGoal(context);
  const db = getDatabase();
  const candidate = db.prepare("SELECT url, title, query FROM web_search_candidates WHERE id = ? AND user_id = ? AND goal_id = ?")
    .get(candidateId, context.userId, context.goalId) as { url: string; title: string; query:string } | undefined;
  if (!candidate) throw new WebSourceError("搜索结果不存在或不属于这个目标。", 404);
  const findExisting = () => (db.prepare(`SELECT s.id FROM web_source_imports w JOIN knowledge_sources s ON s.id = w.source_id
    WHERE w.user_id = ? AND w.url = ? AND s.status = 'ready'`).get(context.userId, candidate.url) as { id: string } | undefined)?.id;
  const run = beginPipelineRun({ userId: context.userId, operation: "ingestion", config: { goalId: context.goalId, purpose: "web_import", url: candidate.url } });
  let sourceId = findExisting();
  const reused = !!sourceId;
  const reviewEnabled = webPageReviewEnabled();
  async function checkPurpose(markdown: string) {
    if (!reviewEnabled) {
      await context.onProgress?.('网页用途审核已关闭；保留抓取正文，收录后由 LLM 判断知识是否足够、是否继续补充');
      recordPipelineStage({ pipelineRunId: run.id, stage: "web_page_review", status: "skipped",
        wallDurationMs: 0, metadata: { reason: "disabled_by_config", policy: "ingest_then_review_coverage" } });
      return null;
    }
    await context.onProgress?.('正文已读取，正在判断是否包含实际教学内容');
    const review = await reviewWebPage(context.userId, candidate!.url, candidate!.title, markdown);
    recordPipelineStage({pipelineRunId:run.id,stage:"web_page_review",wallDurationMs:review.latencyMs,
      cacheState:review.cached?"hit":"miss",inputTokens:review.usage.promptTokens,outputTokens:review.usage.completionTokens,
      metadata:{...review.data,mode:review.mode}});
    if(review.data.kind === 'resource_index' && !childPage) return review.data;
    if(review.data.kind!=="teaching") {
      const advice = review.data.kind==="resource_index" ? "请在原网页选择具体章节，或上传合法持有的书籍正文。" :
        review.data.kind==="promotion" ? "请更换有实际知识讲解的正文页面。" : "可稍后重试，或换一篇具体教学正文。";
      throw new WebSourceError(`page_${review.data.kind}：${review.data.reason} ${advice} 未新增切片或向量。`);
    }
    return review.data;
  }
  try {
    if(sourceId) {
      const stored = db.prepare("SELECT v.extracted_text FROM knowledge_sources s JOIN source_versions v ON v.id=s.current_version_id WHERE s.id=? AND s.user_id=?")
        .get(sourceId,context.userId) as {extracted_text:string}|undefined;
      if(!stored) throw new WebSourceError("无法读取已收录正文，请检查资料版本。");
      const checked = await checkPurpose(stored.extracted_text);
      if(checked && checked.kind !== 'teaching') throw new WebSourceError('已存页面是目录，请选择具体正文。');
    }
    if (!sourceId) {
      await context.onProgress?.('正在连接网站并提取正文（单页最多 60 秒）');
      let started = performance.now();
      // Each selected source/page owns its network deadline; no shared business budget.
      const cap = deadline(WEB_LIMITS.pageMs,'page_timeout：该页面抓取超过 60 秒，可单独重试。');
      let markdown: string;
      try { markdown = await extractWeb(candidate.url,cap.signal); } finally { cap.dispose(); }
      recordPipelineStage({ pipelineRunId: run.id, stage: "web_extract", wallDurationMs: performance.now() - started, provider: process.env.WEB_EXTRACT_PROVIDER || "local" });
      const checked = await checkPurpose(markdown);
      if(checked?.kind === 'resource_index') {
        const links = rankDirectoryLinks(markdown,candidate.url,candidate.query,2);
        if(!links.length) throw new WebSourceError('目录没有与知识缺口匹配的子页面，请选择具体章节。');
        const results: ImportResult[] = [];
        const errors: string[] = [];
        for(const link of links) {
          const id = randomUUID();
          db.prepare('INSERT INTO web_search_candidates(id,user_id,goal_id,query,title,url,snippet,created_at) VALUES(?,?,?,?,?,?,?,?)')
            .run(id,context.userId,context.goalId,candidate.query,link.title,link.url,'selected-directory-child',new Date().toISOString());
          try { results.push(await ingestWebTool(context,id,description,true)); }
          catch(error) { errors.push(error instanceof Error ? error.message : '子页面处理失败'); }
        }
        if(!results.length) throw new WebSourceError(errors.join('；'));
        completePipelineRun(run.id,run.startedMonotonicMs);
        return {...results[0],sourceIds:results.map(result=>result.sourceId),partial:errors.length>0,
          message:`目录本身不作为证据；已收录 ${results.length} 个相关章节。${errors.length ? '部分章节失败，可重试该来源，已成功正文会复用。' : ''}${errors.join('；')}`};
      }
      // Persist the provider's full Markdown, not the search snippet or generated answer.
      const buffer = Buffer.from(`# ${candidate.title}\n\n来源：${candidate.url}\n\n${markdown}`, "utf8");
      await context.onProgress?.(reviewEnabled ? '教学正文已确认，正在解析、切片并保存原文与来源'
        : '正文已抓取，正在解析、切片并保存原文与来源；收录不代表内容已验证');
      started = performance.now();
      const ingestion = await ingestKnowledgeSource({ buffer, kind: "text", filename: "web-source.md", mimeType: "text/markdown" });
      if (ingestion.extracted.status !== "ready") throw new WebSourceError("网页解析失败，请换一个来源。");
      // Another request may have completed while extraction was running.
      sourceId = findExisting() || createKnowledgeSource({
        userId: context.userId, title: candidate.title, description: description.slice(0, 1000),
        kind: "text", originalFilename: "web-source.md", mimeType: "text/markdown", buffer,
        extracted: ingestion.extracted, chunkSet: ingestion.chunkSet, originUrl: candidate.url,
      }).id;
      recordPipelineStage({ pipelineRunId: run.id, stage: "web_parse_persist", wallDurationMs: performance.now() - started });
    }
    checkGoal(context);
    db.prepare(`INSERT INTO goal_source_links (goal_id, source_id, user_id, status, created_at)
      VALUES (?, ?, ?, 'active', ?) ON CONFLICT(goal_id, source_id) DO UPDATE SET status = 'active'`)
      .run(context.goalId, sourceId, context.userId, new Date().toISOString());
    let embeddingStatus = "ready";
    await context.onProgress?.(reused ? '复用已入库正文，检查向量索引' : '正文切片已保存，正在建立向量索引');
    const embeddingStarted = performance.now();
    try { await vectorizeKnowledgeSource({ userId: context.userId, sourceId, model: configuredEmbeddingModel() }); }
    catch { embeddingStatus = "pending"; }
    recordPipelineStage({ pipelineRunId: run.id, stage: "web_embedding", status: embeddingStatus === "ready" ? "completed" : "failed",
      wallDurationMs: performance.now() - embeddingStarted, metadata: { sourceId, reused },
      errorCode: embeddingStatus === "ready" ? "" : "embedding_pending" });
    completePipelineRun(run.id, run.startedMonotonicMs);
    return { sourceId, reused, embeddingStatus, durationMs: Math.round(performance.now() - run.startedMonotonicMs),
      message: (embeddingStatus === "ready" ? "资料已收录并加入本目标，可用于检索。" : "资料已收录并加入本目标，可用全文检索；向量化暂未完成，可在资料库重试。")
        + (reviewEnabled ? "" : "未执行网页用途审核；是否支持当前教学内容，由检索后的 LLM 判断。") };
  } catch (error) {
    failPipelineRun({ id: run.id, startedMonotonicMs: run.startedMonotonicMs, errorCode: "web_import_failed", errorMessage: error instanceof Error ? error.message : "收录失败" });
    throw error;
  }
}
