import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.SQLITE_DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'ragflow-smoke-')), 'test.sqlite');
process.env.RAGFLOW_BASE_URL = 'http://ragflow.invalid';
process.env.RAGFLOW_API_KEY = 'test-only';
process.env.LLM_PROVIDER = 'test';
process.env.LLM_API_KEY = 'test-only';
process.env.LLM_BASE_URL = 'https://review.invalid';
process.env.LLM_MODEL = 'test';
const { getDatabase } = await import('../lib/db/index.ts');
const { importRagflowDocument } = await import('../lib/knowledge/ragflow-import.ts');
const { retrieveRagflow } = await import('../lib/knowledge/ragflow-client.ts');
const { searchGoalKnowledgeBase, readTutorEvidence } = await import('../lib/db/retrieval.ts');
const db = getDatabase();
const now = new Date().toISOString();
for (const id of ['owner', 'other']) {
  db.prepare(`INSERT INTO users (id,username,password_hash,display_name,created_at,updated_at) VALUES (?,?,'test',?,?,?)`).run(id,id,id,now,now);
  db.prepare(`INSERT INTO goals (id,user_id,title,description,progress_updated_at,created_at,updated_at) VALUES (?,?,'Agent tools','',?,?,?)`).run(id,id,now,now,now);
  db.prepare(`INSERT INTO goal_learning_profiles (goal_id,user_id,self_level,weekly_hours,diagnostic_required,diagnostic_status,source_scope_mode,created_at,updated_at)
    VALUES (?,?,'beginner',4,0,'skipped','auto',?,?)`).run(id,id,now,now);
}
const chunks = [1,2,3,4,5,6].map(i => ({ id: `chunk${i}`, document_id: 'document', dataset_id: 'dataset',
  content: `Agent tool example ${i}. ` + '工具调用需要结构化参数、权限校验与结果验证。'.repeat(40), available: true, similarity: .8 - i / 100 }));
let behavior = 'ok'; let ragCalls = 0;
const queries = [];
globalThis.fetch = async (url, options) => {
  const address = String(url);
  if (address === 'https://review.invalid/chat/completions') {
    const input = JSON.parse(JSON.parse(options.body).messages.find(m => m.role === 'user').content);
    return Response.json({ choices: [{ message: { content: JSON.stringify({ sufficient: true,
      relevantChunkIds: input.items.map(i => i.chunkId), missingTopics: [], reason: 'fixture' }) } }] });
  }
  assert(address.startsWith('http://ragflow.invalid/api/v1/'));
  assert.equal(options.headers.Authorization, 'Bearer test-only');
  assert.equal(options.redirect, 'error');
  if (address.endsWith('/retrieval')) {
    ragCalls++;
    const request = JSON.parse(options.body);
    queries.push(request.question);
    assert.deepEqual(request.dataset_ids, ['dataset']);
    assert.deepEqual(request.document_ids, ['document']);
    if (behavior === 'offline') throw new Error('connection');
    if (behavior === 'business_error') return Response.json({code: 102, data: {chunks: []}});
    if (behavior === 'topics') return Response.json({code:0,data:{chunks: request.question === 'overview' ? chunks.slice(0,3) : request.question === 'stopping' ? [chunks[3]] : chunks.slice(4)}});
    return Response.json({ code: 0, data: { chunks: chunks.map((c,i) => i !== 0 ? c : behavior === 'foreign'
      ? {...c, document_id: 'someone-else'} : behavior === 'changed' ? {...c, content: 'changed'} : c) } });
  }
  if (address.includes('/chunks?')) return Response.json({code: 0, data: {total: chunks.length, chunks}});
  return Response.json({code: 0, data: { docs: [{id:'document',name:'Agent lesson',run:'DONE'}] }});
};
try {
  const imported = await importRagflowDocument('owner','dataset','document');
  assert.equal(imported.chunks,6);
  assert.equal((await importRagflowDocument('owner','dataset','document')).reused,true);
  const run = await searchGoalKnowledgeBase({userId:'owner',goalId:'owner',query:'Agent tools',purpose:'lesson_generation'});
  assert.equal(run.retrievalMode,'ragflow'); assert.equal(run.status,'sufficient'); assert.equal(run.resultCount,6);
  assert.equal(readTutorEvidence('owner','owner',run.retrievalRunId).sources.length,6);
  const priorQueries = ragCalls;
  const fused = await retrieveRagflow({datasetId:'dataset',documentIds:['document'],query:'What is an agent? What is a tool? What is observation? How to retry?',topK:6});
  assert.equal(ragCalls-priorQueries,3,'multi-question retrieval has at most three subqueries');
  assert.equal(fused.length,6); assert.equal(new Set(fused.map(c=>c.id)).size,6);
  behavior='topics';
  const balanced = await retrieveRagflow({datasetId:'dataset',documentIds:['document'],query:'overview',targetTopics:['overview','stopping','failures'],topK:3});
  assert.deepEqual(queries.slice(-3),['overview','stopping','failures']);
  assert.deepEqual(balanced.map(c=>c.id),['chunk1','chunk4','chunk5'],'each topic survives a small evidence limit');
  behavior='ok';
  assert.throws(() => readTutorEvidence('other','owner',run.retrievalRunId));
  const qa = await searchGoalKnowledgeBase({userId:'owner',goalId:'owner',query:'Agent tools',purpose:'classroom_qa'});
  assert.equal(qa.retrievalMode,'ragflow'); assert(qa.resultCount > 0);
  const before = ragCalls;
  await retrieveRagflow({datasetId:'dataset',documentIds:[],query:'x',topK:3});
  const other = await searchGoalKnowledgeBase({userId:'other',goalId:'other',query:'Agent',purpose:'classroom_qa'});
  assert.equal(other.resultCount,0); assert.equal(ragCalls,before);
  for (behavior of ['foreign','changed','offline','business_error']) {
    await assert.rejects(searchGoalKnowledgeBase({userId:'owner',goalId:'owner',query:'Agent',purpose:'classroom_qa'}));
  }
  behavior = 'ok';
  const beforeExclude = ragCalls;
  db.prepare(`UPDATE goal_learning_profiles SET source_scope_mode='selected' WHERE goal_id='owner'`).run();
  const excluded = await searchGoalKnowledgeBase({userId:'owner',goalId:'owner',query:'Agent',purpose:'classroom_qa'});
  assert.equal(excluded.resultCount,0); assert.equal(ragCalls,beforeExclude);
  console.log('PASS: import/replay, RAGFlow lesson + QA, immutable citations, account/scope isolation, empty scope, changed chunks, upstream failures.');
} finally { db.close(); }
