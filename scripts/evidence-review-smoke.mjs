import assert from 'node:assert/strict';
import { reviewTeachingEvidence } from '../lib/knowledge/evidence-review.ts';
process.env.LLM_PROVIDER = 'test'; process.env.LLM_API_KEY = 'test';
process.env.LLM_BASE_URL = 'https://example.invalid'; process.env.LLM_MODEL = 'test';
const original = globalThis.fetch;
const input = { goal: { title: 'Java', description: '学习 Java 类型系统' }, query: 'Java 基本类型', items: [{ chunkId: 'a', sourceTitle: 'Agent', snapshotText: 'Agent tool calling' }] };
let output;
globalThis.fetch = async (_url, options) => {
  const payload=JSON.parse(JSON.parse(options.body).messages.find(m=>m.role==='user').content);
  assert.equal(payload.goal,undefined,'whole-course goal must not expand this lesson review');
  assert.equal(payload.items[0].excerpt,undefined,'duplicate full text is not sent');
  assert(payload.scopeRule.includes('唯一审核范围'));
  return Response.json({ choices: [{ message: { content: JSON.stringify(output) } }] });
};
try {
  output = { sufficient: false, relevantChunkIds: [], missingTopics: ['Java 类型'], reason: '资料只讨论 Agent' };
  assert.equal((await reviewTeachingEvidence(input)).data.sufficient, false);
  output = { sufficient: true, relevantChunkIds: ['unknown'], missingTopics: [], reason: '相关' };
  assert.equal((await reviewTeachingEvidence(input)).mode, 'rules');
  output = { sufficient: true, relevantChunkIds: ['a'], missingTopics: ['缺失主题'], reason: '有缺口' };
  assert.equal((await reviewTeachingEvidence(input)).data.sufficient, false);
  output = { sufficient: true, relevantChunkIds: ['a'], missingTopics: [], reason: '覆盖本节目标' };
  assert.equal((await reviewTeachingEvidence(input)).data.sufficient, true);
  assert.equal((await reviewTeachingEvidence({...input,knowledgeNeed:'current'})).data.sufficient,false,
    'Relevance alone is not freshness evidence');
  output.freshnessEvidence={chunkId:'a',quote:'Java version 25 released in 2025'};
  assert.equal((await reviewTeachingEvidence({...input,knowledgeNeed:'current'})).data.sufficient,false,
    'Invented freshness quote must be rejected');
  assert.equal((await reviewTeachingEvidence({...input,knowledgeNeed:'current',items:[{...input.items[0],snapshotText:'Java version 25 released in 2025'}]})).data.sufficient,true);
  const scoped={...input,lessonScope:{title:'Agent',objective:'识别工具调用'},items:[{...input.items[0],excerpt:'duplicate',snapshotText:'Agent tool calling'}]};
  output={sufficient:true,relevantChunkIds:['a'],missingTopics:[],reason:'覆盖原始要求',checks:[{requirementId:'r1',status:'covered',citations:[{chunkId:'a',quote:'Agent tool calling'}],note:'原文依据'}]};
  assert.equal((await reviewTeachingEvidence(scoped)).data.sufficient,true);
  output.checks[0].citations[0].quote='invented evidence';
  assert.equal((await reviewTeachingEvidence(scoped)).mode,'rules');
  output.checks[0]={requirementId:'r1',status:'partial',citations:[],note:'不完整'};
  assert.equal((await reviewTeachingEvidence(scoped)).data.sufficient,false);
  output.checks=[];
  assert.equal((await reviewTeachingEvidence(scoped)).mode,'rules','every original requirement must be assessed');
  globalThis.fetch = async () => { throw new Error('offline'); };
  assert.equal((await reviewTeachingEvidence(input)).data.sufficient, false);
  console.log('PASS: insufficient, unknown citation rejection, inconsistent coverage rejection, sufficient and unavailable (mock LLM).');
} finally { globalThis.fetch = original; }
