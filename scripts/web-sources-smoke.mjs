import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SQLITE_DATABASE_PATH = join(mkdtempSync(join(tmpdir(), "growth-web-test-")), "test.sqlite");
process.env.TAVILY_API_KEY = "test-only";
process.env.WEB_SEARCH_PROVIDER = "tavily";
process.env.WEB_EXTRACT_PROVIDER = "tavily";
process.env.WEB_PAGE_REVIEW_ENABLED = "true"; // Preserve opt-in review/directory compatibility coverage.
process.env.RAG_INGESTION_URL = "";
process.env.EMBEDDING_SERVICE_URL = "";
process.env.LLM_PROVIDER = "openai-compatible";
process.env.LLM_BASE_URL = "https://model.test";
process.env.LLM_API_KEY = "test";
process.env.LLM_MODEL = "test";
const { getDatabase } = await import("../lib/db/index.ts");
const { searchWebTool, ingestWebTool, importWebBatch } = await import("../lib/knowledge/web-tools.ts");
const { publicWebUrl } = await import("../lib/knowledge/web-provider.ts");
const { searchGoalKnowledgeBase } = await import("../lib/db/retrieval.ts");
const db = getDatabase();
const now = new Date().toISOString();
for (const id of ["a", "b"]) {
  db.prepare("INSERT INTO users (id, username, password_hash, display_name, created_at, updated_at) VALUES (?, ?, 'x', ?, ?, ?)").run(id, id, id, now, now);
  db.prepare("INSERT INTO goals (id, user_id, title, description, progress_updated_at, created_at, updated_at) VALUES (?, ?, 'transaction', '', ?, ?, ?)").run(`g-${id}`, id, now, now, now);
}
const context = { userId: "a", goalId: "g-a" };
let searches = 0;
let extracts = 0;
let reviewKind = "teaching";
let reviewCalls = 0;
let unavailable = true;
let failedChild = true;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if(String(url).startsWith("https://model.test/")) { reviewCalls++; return Response.json({choices:[{message:{content:JSON.stringify({
    kind:reviewKind,reason:"页面用途测试",excerpt:"transaction isolation prevents dirty reads and controls concurrent access."
  })},finish_reason:"stop"}],usage:{prompt_tokens:100,completion_tokens:30,total_tokens:130}}); }
  assert(String(url).startsWith("https://api.tavily.com/"), "server must never fetch arbitrary websites directly");
  const body = JSON.parse(options.body);
  if (String(url).endsWith("/search")) {
    searches++;
    assert.equal(body.include_answer, false);
    return Response.json({ results: [
      { title: "Transactions", url: "https://example.com/transactions", content: "search snippet only" },
      { title: "unsafe", url: "http://127.0.0.1/secret", content: "reject" },
    ] });
  }
  extracts++;
  if (body.urls[0].endsWith('/directory-4/chapter-0') && failedChild) return new Response('', {status:503});
  if (body.urls[0].endsWith('/unavailable') && unavailable) return new Response('', {status:503});
  if (/\/directory(?:-\d+)?$/.test(body.urls[0])) return Response.json({results:[{url:body.urls[0],raw_content:
    Array.from({length:10},(_,i)=>`[transaction chapter ${i}](${body.urls[0]}/chapter-${i})`).join('\n')}]});
  assert.equal(body.query, undefined, "extract full body, not query snippets");
  return Response.json({ results: [{ url: body.urls[0], raw_content: "# transaction\n\n" + "transaction isolation prevents dirty reads and controls concurrent access. Commit makes changes durable; rollback discards changes.\n\n".repeat(15) }] });
};
try {
  for (const url of ["file:///etc/passwd", "http://localhost", "http://127.1", "http://2130706433", "http://[::1]", "http://metadata.google.internal", "https://user:pass@example.com", "https://example.com:6000"]) {
    assert.throws(() => publicWebUrl(url), url);
  }
  await assert.rejects(() => searchWebTool({ userId: "b", goalId: "g-a" }, "transaction"));
  assert.equal(searches, 0);
  const { candidates } = await searchWebTool(context, "transaction");
  assert.equal(candidates.length, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM knowledge_sources").get().n, 0);
  await assert.rejects(() => ingestWebTool({ userId: "b", goalId: "g-b" }, candidates[0].id, ""));
  const imported = await ingestWebTool(context, candidates[0].id, "学习事务隔离");
  assert.equal(imported.embeddingStatus, "pending");
  const again = await ingestWebTool(context, candidates[0].id, "");
  assert.equal(again.sourceId, imported.sourceId);
  assert.equal(again.reused, true);
  assert.equal(extracts, 1);
  const source = db.prepare("SELECT extracted_text FROM source_versions WHERE source_id = ?").get(imported.sourceId);
  assert(source.extracted_text.includes("Commit makes changes durable"));
  assert(!source.extracted_text.includes("search snippet only"));
  const evidence = await searchGoalKnowledgeBase({ ...context, query: "transaction", purpose: "classroom_qa", mode: "fts5" });
  assert(evidence.resultCount > 0);
  assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
  const before=extracts;
  await assert.rejects(importWebBatch(context,['one','two','three','four'],'',()=>{}),/1–3/);
  await assert.rejects(importWebBatch(context,[candidates[0].id,'foreign'],'',()=>{}),/不属于/);
  assert.equal(extracts,before,'Validate entire batch before any download');
  for(const id of ['unavailable','second']) db.prepare("INSERT INTO web_search_candidates (id,user_id,goal_id,query,title,url,snippet,created_at) VALUES (?, 'a','g-a','transaction',? ,?,'',?)")
    .run(id,id,'https://example.com/'+id,now);
  const events=[];
  await importWebBatch(context,[candidates[0].id,'unavailable','second'],'test',event=>events.push(event));
  assert.deepEqual(events.filter(e=>e.type==='item').map(e=>e.ok),[true,false,true]);
  assert.equal(events.at(-1).type,'done');
  console.log('PASS: max-three, ownership preflight, cached reuse, partial failure continues, batch completion.');
  const {createGate,gateIdentity,saveGate,readGate}=await import('../lib/db/knowledge-gates.ts');
  const gateId=gateIdentity('a','g-a','directory-test');
  createGate(gateId,'a','g-a',{teachingIntent:'learn',knowledgeNeed:'verify',query:'transaction',targetTopics:['transaction']});
  saveGate(gateId,'waiting_for_sources',null,'before');
  db.prepare('UPDATE knowledge_gates SET page_count=3,rag_count=2,web_count=1 WHERE id=?').run(gateId);
  db.prepare("INSERT INTO web_search_candidates(id,user_id,goal_id,query,title,url,snippet,created_at) VALUES('directory','a','g-a','transaction','directory','https://example.com/directory','',?)").run(now);
  const beforeDirectory=extracts;
  const directory=await ingestWebTool(context,'directory','');
  assert(directory.message.includes('2 个相关章节'));
  assert.equal(extracts-beforeDirectory,3,'directory + two child pages, no recursive crawl');
  assert.equal(readGate(gateId).page_count,3);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM web_source_imports WHERE url='https://example.com/directory'").get().n,0,'Directory must not enter evidence');
  const beforeRetry=extracts;
  unavailable=false;
  await ingestWebTool(context,'unavailable','');
  assert.equal(extracts,beforeRetry+1,'failed source can be retried independently despite old exhausted counters');
  for(const id of ['directory-1','directory-2','directory-3']) db.prepare("INSERT INTO web_search_candidates(id,user_id,goal_id,query,title,url,snippet,created_at) VALUES(?,'a','g-a','transaction',?,?,'',?)").run(id,id,'https://example.com/'+id,now);
  const beforeDirectories=extracts, directoryEvents=[];
  await importWebBatch(context,['directory-1','directory-2','directory-3'],'',e=>directoryEvents.push(e));
  assert.equal(extracts-beforeDirectories,9,'each of three selected directories gets its own index + two children');
  assert.deepEqual(directoryEvents.filter(e=>e.type==='item').map(e=>e.ok),[true,true,true]);
  db.prepare("INSERT INTO web_search_candidates(id,user_id,goal_id,query,title,url,snippet,created_at) VALUES('directory-4','a','g-a','transaction','directory','https://example.com/directory-4','',?)").run(now);
  const partial=await ingestWebTool(context,'directory-4','');
  assert.equal(partial.partial,true);assert.equal(partial.sourceIds.length,1);
  failedChild=false;
  const beforePartialRetry=extracts;
  const recovered=await ingestWebTool(context,'directory-4','');
  assert.equal(recovered.partial,false);assert.equal(recovered.sourceIds.length,2);
  assert(recovered.sourceIds.includes(partial.sourceId));
  assert.equal(extracts-beforePartialRetry,2,'retry directory and failed child only; reuse successful child');
  saveGate(gateId,'resolved',null,'after');
  console.log('PASS: per-source directory limits, three directories/nine pages, historical counters ignored, independent retry, no directory ingestion.');
  reviewKind="promotion";
  db.prepare("INSERT INTO web_search_candidates(id,user_id,goal_id,query,title,url,snippet,created_at) VALUES('ad','a','g-a','transaction','ad','https://example.com/ad','',?)").run(now);
  const sourcesBefore=db.prepare("SELECT COUNT(*) AS n FROM knowledge_sources").get().n;
  await assert.rejects(ingestWebTool(context,'ad',''),/page_promotion/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM knowledge_sources").get().n,sourcesBefore);
  const lastRun=db.prepare("SELECT id FROM pipeline_runs ORDER BY rowid DESC LIMIT 1").get().id;
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pipeline_stage_metrics WHERE pipeline_run_id=? AND stage IN ('web_parse_persist','web_embedding')").get(lastRun).n,0);
  console.log('PASS: rejected page never reaches chunking/persistence/embedding.');
  delete process.env.WEB_PAGE_REVIEW_ENABLED; // Default off, including cached rejection from a prior attempt.
  const callsBefore = reviewCalls;
  const progress = [];
  const bypassed = await ingestWebTool({...context,onProgress:async message=>progress.push(message)},'ad','');
  assert(bypassed.sourceId); assert(bypassed.message.includes('未执行网页用途审核'));
  assert(progress.some(message=>message.includes('审核已关闭')));
  assert(!progress.some(message=>message.includes('教学正文已确认')));
  const reusedBypass = await ingestWebTool(context,'ad','');
  assert.equal(reusedBypass.sourceId,bypassed.sourceId);assert(reusedBypass.reused);
  const beforeUncheckedDirectory = extracts;
  const uncheckedDirectory = await ingestWebTool({...context,trigger:'agent'},'directory','',true);
  assert(uncheckedDirectory.sourceId);
  assert.equal(extracts,beforeUncheckedDirectory+1,'review off stores fetched page, no automatic directory crawl');
  assert.equal(reviewCalls,callsBefore,'neither fresh nor reused imports call page reviewer when disabled');
  assert(db.prepare("SELECT count(*) n FROM pipeline_stage_metrics WHERE stage='web_page_review' AND status='skipped'").get().n>=3);
  assert(db.prepare("SELECT extracted_text FROM source_versions WHERE source_id=?").get(uncheckedDirectory.sourceId).extracted_text.includes('transaction chapter'));
  await assert.rejects(()=>ingestWebTool({userId:'b',goalId:'g-b'},'ad',''),/不存在|不属于/);
  console.log('PASS: default-disabled review, no classification calls, cached rejection ignored, neutral progress, source reuse and directory text ingestion; ownership still enforced.');
  delete process.env.TAVILY_API_KEY;
  await assert.rejects(() => searchWebTool(context, "transaction"), /TAVILY_API_KEY/);
  console.log(JSON.stringify({ ok: true, ownership: "passed", unsafeUrls: "passed", candidatesNotSources: "passed", importAndRetrieve: "passed", singleFetch: "passed", embeddingFallback: "passed", database: process.env.SQLITE_DATABASE_PATH }));
} finally { globalThis.fetch = realFetch; db.close(); }
