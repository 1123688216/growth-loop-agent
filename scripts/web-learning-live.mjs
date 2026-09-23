import { spawn } from 'node:child_process';
import { mkdirSync, openSync, closeSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';

if (!process.argv.includes('--live')) throw new Error('Pass --live: creates a test account/goal, imports public data and calls configured models.');
const stamp = Date.now();
const runtime = resolve('.runtime'); mkdirSync(runtime, { recursive: true });
const report = resolve(runtime, `web-learning-live-${stamp}.jsonl`);
const originalLog = console.log;
console.log = (...args) => { appendFileSync(report, args.join(' ') + '\n'); originalLog(...args); };
// Pick a free local port; a competing listener is not stopped.
const reservation = createServer();
await new Promise((r) => reservation.listen(0, '127.0.0.1', r));
const port = reservation.address().port;
await new Promise((r) => reservation.close(r));
const out = openSync(resolve(runtime, `workflow-live-${stamp}.log`), 'a');
const env = { ...process.env, WORKFLOW_CHECKPOINT_PATH: resolve(runtime, `workflow-live-${stamp}.sqlite`), WORKFLOW_LLM_ENABLED: 'true' };
for (const suffix of ['BASE_URL', 'API_KEY', 'MODEL']) env[`WORKFLOW_LLM_${suffix}`] ||= env[`LLM_${suffix}`];
const child = spawn(resolve('services/workflow/.venv/Scripts/python.exe'), ['-m', 'uvicorn', 'growth_loop_workflow.main:app', '--host', '127.0.0.1', '--port', String(port)], {
  cwd: resolve('services/workflow'), env, windowsHide: true, stdio: ['ignore', out, out],
});
process.env.WORKFLOW_SERVICE_URL = `http://127.0.0.1:${port}`;
process.env.WEB_EXTRACT_PROVIDER = 'local';
const base = 'http://127.0.0.1:3000';
try {
  let healthy = false;
  for (let i = 0; i < 30; i++) {
    if (child.exitCode !== null) throw new Error('Temporary workflow exited; inspect its runtime log.');
    try { const r = await fetch(process.env.WORKFLOW_SERVICE_URL + '/health'); const h = await r.json(); healthy = h.query_planner === 'pydantic_ai'; } catch { }
    if (healthy) break;
    await new Promise(r => setTimeout(r, 500));
  }
  assert(healthy, 'Temporary workflow must have configured Pydantic AI');
  const username = `webtest_${stamp}`;
  const reg = await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: crypto.randomUUID(), displayName: 'Web workflow test' }) });
  const user = await reg.json(); assert(reg.ok, user.error);
  const headers = { 'Content-Type': 'application/json', Cookie: reg.headers.getSetCookie().map(x => x.split(';')[0]).join('; ') };
  const response = await fetch(base + '/api/goals', { method: 'POST', headers, body: JSON.stringify({ title: 'Java primitive types and reference types', description: 'Teach Java primitive types, reference types and null with concrete Java examples.', selfLevel: 'beginner', weeklyHours: 4 }) });
  const created = await response.json(); assert(response.ok, created.error);
  const goalId = created.goal.id;
  console.log(JSON.stringify({ stage: 'test_account_and_goal', username, goalId }));
  const { runWebResearch } = await import('../lib/workflow/web-research.ts');
  const result = await runWebResearch({ userId: user.user.id, goalId, query: 'Java primitive types reference types null official tutorial for beginners', automatic: true,
    onProgress: async message => console.log(JSON.stringify({ stage: 'research', message })) });
  console.log(JSON.stringify({ stage: 'research_result', ...result }));
  assert.equal(result.status, 'needs_selection', result.error || result.message);
  assert(result.candidates?.length, 'No candidates returned');
  // Simulate explicit confirmation in this opt-in test, not automatic production import.
  const { ingestWebTool } = await import('../lib/knowledge/web-tools.ts');
  const imported = await ingestWebTool({userId:user.user.id,goalId}, result.candidates[0].id, 'Live test: explicitly select first candidate');
  console.log(JSON.stringify({stage:'confirmed_import', ...imported}));
  const { searchKnowledgeBaseTool } = await import('../lib/knowledge/search-tool.ts');
  const evidence = await searchKnowledgeBaseTool({ userId: user.user.id, goalId, purpose: 'lesson_generation' }, { query: 'Java primitive types reference types null', maxEvidenceTokens: 2400 });
  console.log(JSON.stringify({ stage: 'teaching_review', status: evidence.status, reason: evidence.insufficiencyReason, count: evidence.resultCount }));
  assert.equal(evidence.status, 'sufficient');
  console.log(JSON.stringify({ stage: 'course_generation', message: 'Calling existing course-generation API with the test login; research above used isolated workflow.' }));
  const courseResponse = await fetch(base + '/api/learning-program', { method: 'POST', headers, body: JSON.stringify({ action: 'generate', goalId, lessonCount: 3 }), signal: AbortSignal.timeout(300000) });
  const course = await courseResponse.json();
  console.log(JSON.stringify({ stage: 'course_result', http: courseResponse.status, error: course.error, programId: course.program?.programId,
    firstLesson: course.program?.lessons?.[0] && { status: course.program.lessons[0].generationStatus, issues: course.program.lessons[0].qualityReport?.issues?.map(i => i.message) } }));
  assert(courseResponse.ok && course.program?.lessons?.[0]?.generationStatus === 'ready', 'Course did not pass: see saved test report.');
} catch (error) {
  console.log(JSON.stringify({ stage: 'failed', message: error.message }));
  process.exitCode = 1;
} finally {
  // This is the exact temporary process spawned above, never the user's running workflow.
  if (child.exitCode === null) { child.kill(); await new Promise(r => child.once('exit', r)); }
  closeSync(out);
}
