import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SQLITE_DATABASE_PATH = join(mkdtempSync(join(tmpdir(), "auto-web-test-")), "test.sqlite");
process.env.WORKFLOW_SERVICE_URL = "http://workflow.test";
const { getDatabase } = await import("../lib/db/index.ts");
const { runWebResearch } = await import("../lib/workflow/web-research.ts");
const db = getDatabase();
const now = new Date().toISOString();
db.prepare("INSERT INTO users (id, username, password_hash, display_name, created_at, updated_at) VALUES ('a', 'a', 'x', 'a', ?, ?)").run(now, now);
db.prepare("INSERT INTO goals (id, user_id, title, description, progress_updated_at, created_at, updated_at) VALUES ('g', 'a', '事务', '', ?, ?, ?)").run(now, now, now);
const realFetch = globalThis.fetch;
const finished = new Set();
let selections = 0;
let noRecommendation = false;
globalThis.fetch = async (url, options) => {
  assert.equal(String(url), "http://workflow.test/v1/web-research/advance");
  const body = JSON.parse(options.body);
  if (body.resume) {
    assert.equal(body.resume.candidate_id, "recommended");
    selections++;
    finished.add(body.thread_id);
  }
  if (finished.has(body.thread_id)) return Response.json({ status: "completed", state: { result: { sourceId: "source-1", message: "已收录" } } });
  return Response.json({ status: "waiting_for_user", state: {
    candidates: [{ id: "first-hit" }, { id: "recommended" }],
    recommendations: noRecommendation ? [] : [{ candidate_id: "recommended", reason: "与目标匹配" }],
  } });
};
try {
  const input = { userId: "a", goalId: "g", query: "事务", automatic: true, workflowKey: "web-research:test" };
  assert.equal((await runWebResearch(input)).status, "needs_selection");
  assert.equal((await runWebResearch(input)).status, "needs_selection");
  assert.equal(selections, 0, "automatic search must never import before user selection");
  noRecommendation = true;
  assert.equal((await runWebResearch({ ...input, workflowKey: "web-research:no-recommendation" })).status, "needs_selection");
  assert.equal(selections, 0, "no recommendation must not auto-import the first hit");
  await assert.rejects(() => runWebResearch({ ...input, userId: "other" }));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM web_research_runs").get().n, 2);
  await runWebResearch({userId:'a', goalId:'g', query:'Java', requirements:'上一批太难，要中文入门案例'});
  assert.match(db.prepare('SELECT query FROM web_research_runs ORDER BY rowid DESC LIMIT 1').get().query, /中文入门案例/);
  console.log("PASS: preview only, stable run recovery, feedback persisted, ownership validation (mock workflow, isolated database).");
} finally { globalThis.fetch = realFetch; db.close(); }
