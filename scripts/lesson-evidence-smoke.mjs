import assert from 'node:assert/strict';
import { resolveLessonEvidence } from '../lib/learning-loop/lesson-evidence.ts';

const good = { status: 'sufficient', insufficiencyReason: '' };
const bad = { status: 'insufficient', insufficiencyReason: 'no_matching_evidence' };
async function scenario({ results = [bad, good], autoWeb = true, workflowConfigured = true, failSearch = false, webError = '' } = {}) {
  const counts = { search: 0, web: 0, messages: [] };
  const task = resolveLessonEvidence({ autoWeb, workflowConfigured,
    search: async () => { const index = counts.search++; if (failSearch) throw new Error('retrieval service offline'); return results[index] || bad; },
    supplement: async () => { counts.web++; return { error: webError, message: '补充完成' }; },
    report: async (message) => { counts.messages.push(message); },
  });
  return { task, counts };
}
let s = await scenario({ results: [good] });
assert.equal((await s.task).status, 'sufficient'); assert.equal(s.counts.web, 0);
s = await scenario(); await s.task; assert.equal(s.counts.search, 2); assert.equal(s.counts.web, 1);
s = await scenario({ results: [bad, bad] }); await assert.rejects(s.task, /source_insufficient/); assert.equal(s.counts.web, 1);
s = await scenario({ workflowConfigured: false }); await assert.rejects(s.task, /WORKFLOW_SERVICE_URL/); assert.equal(s.counts.web, 0);
s = await scenario({ webError: 'timeout' }); await assert.rejects(s.task, /timeout/); assert.equal(s.counts.search, 1);
s = await scenario({ autoWeb: false }); assert.equal((await s.task).status, 'insufficient'); assert.equal(s.counts.web, 0);
s = await scenario({ failSearch: true }); await assert.rejects(s.task, /offline/); assert.equal(s.counts.web, 0);
console.log('PASS: local sufficient, supplement + requery, still insufficient, missing workflow, web failure, disabled, retrieval failure. No real LLM calls.');
let searches=0;
await assert.rejects(resolveLessonEvidence({autoWeb:true,workflowConfigured:true,
  search:async()=>{searches++;return bad;},supplement:async()=>({status:'needs_selection',message:'请多选资料'}),report:async()=>{}}),/请多选资料/);
assert.equal(searches,1,'Do not requery or generate while waiting for selection');
