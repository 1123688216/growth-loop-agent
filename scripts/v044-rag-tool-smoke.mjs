import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporaryDirectory = mkdtempSync(join(tmpdir(), "growth-loop-rag-tool-"));
process.env.SQLITE_DATABASE_PATH = join(temporaryDirectory, "rag-tool.sqlite");
// Isolated model boundary: never load real credentials or contact a provider.
process.env.LLM_PROVIDER = 'test';
process.env.LLM_API_KEY = 'test';
process.env.LLM_BASE_URL = 'https://rag-review.invalid';
process.env.LLM_MODEL = 'test';
const originalFetch = globalThis.fetch;
let reviewBehavior = 'sufficient';
let reviewCalls = 0;
globalThis.fetch = async (url, options) => {
  assert.equal(String(url), 'https://rag-review.invalid/chat/completions');
  reviewCalls += 1;
  if (reviewBehavior === 'unavailable') return Response.json({ error: 'test unavailable' }, { status: 503 });
  const request = JSON.parse(options.body);
  const evidence = JSON.parse(request.messages.find(message => message.role === 'user').content);
  assert(evidence.items.length > 0);
  const sufficient = reviewBehavior === 'sufficient';
  return Response.json({ choices: [{ message: { content: JSON.stringify({
    sufficient, relevantChunkIds: sufficient ? evidence.items.map(item => item.chunkId) : [],
    missingTopics: sufficient ? [] : ['uncovered topic'], reason: sufficient ? 'fixture evidence covers query' : 'fixture evidence is irrelevant',
  }) } }] });
};

const { getDatabase } = await import("../lib/db/index.ts");
const {
  GoalSourceScopeError,
  readGoalSourceScope,
  updateGoalSourceScope,
} = await import("../lib/db/goal-sources.ts");
const {
  KnowledgeRetrievalError,
  readWorkflowRetrievalSummary,
  readTutorEvidence,
  searchGoalKnowledgeBase,
} = await import("../lib/db/retrieval.ts");

const database = getDatabase();
const { attachLessonSources, checkLessonSources } = await import("../lib/learning-program/grounding.ts");
const now = "2026-09-01T00:00:00.000Z";

function insertUser(id, username) {
  database.prepare(`
    INSERT INTO users (id, username, password_hash, display_name, created_at, updated_at)
    VALUES (?, ?, 'test-hash', ?, ?, ?)
  `).run(id, username, username, now, now);
}

function insertGoal(id, userId, title, withProfile = true) {
  database.prepare(`
    INSERT INTO goals (
      id, user_id, title, description, progress_updated_at, created_at, updated_at
    ) VALUES (?, ?, ?, '', ?, ?, ?)
  `).run(id, userId, title, now, now, now);
  if (withProfile) {
    database.prepare(`
      INSERT INTO goal_learning_profiles (
        goal_id, user_id, self_level, weekly_hours, diagnostic_required,
        diagnostic_status, source_scope_mode, created_at, updated_at
      ) VALUES (?, ?, 'beginner', 4, 0, 'skipped', 'auto', ?, ?)
    `).run(id, userId, now, now);
  }
}

function insertSource({ sourceId, userId, title, term }) {
  const versionId = `${sourceId}-version`;
  const parseRunId = `${sourceId}-parse`;
  const chunkSetId = `${sourceId}-set`;
  const paragraphs = [
    `${term} 是这份资料的核心概念。它说明如何建立清晰的输入、处理步骤与可验证输出，并通过具体证据检查结论。`,
    `${term} 的进阶实践强调边界条件、失败分支和复盘。学习者需要比较不同方案，再解释为什么选择当前方法。`,
  ];
  const extracted = paragraphs.join("\n\n");
  database.prepare(`
    INSERT INTO knowledge_sources (
      id, user_id, title, description, kind, content_hash, status, parser_version,
      current_version_id, chunk_count, char_count, created_at, updated_at
    ) VALUES (?, ?, ?, 'RAG Tool smoke source', 'text', ?, 'ready', 'test-v1', ?, 2, ?, ?, ?)
  `).run(sourceId, userId, title, `${sourceId}-hash`, versionId, extracted.length, now, now);
  database.prepare(`
    INSERT INTO source_versions (
      id, source_id, user_id, version, raw_blob, extracted_text, text_hash,
      parser_version, status, created_at
    ) VALUES (?, ?, ?, 1, ?, ?, ?, 'test-v1', 'ready', ?)
  `).run(versionId, sourceId, userId, Buffer.from(extracted), extracted, `${sourceId}-text-hash`, now);
  database.prepare(`
    INSERT INTO document_parse_runs (
      id, source_version_id, source_id, user_id, parser_name, parser_version,
      status, normalized_markdown, text_hash, node_count, created_at, completed_at
    ) VALUES (?, ?, ?, ?, 'test', 'test-v1', 'ready', ?, ?, 2, ?, ?)
  `).run(parseRunId, versionId, sourceId, userId, extracted, `${sourceId}-text-hash`, now, now);
  paragraphs.forEach((paragraph, index) => {
    database.prepare(`
      INSERT INTO document_nodes (
        id, parse_run_id, source_version_id, source_id, user_id, position,
        node_type, text, char_start, char_end, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'paragraph', ?, 0, ?, ?)
    `).run(`${sourceId}-node-${index}`, parseRunId, versionId, sourceId, userId, index, paragraph, paragraph.length, now);
  });
  database.prepare(`
    INSERT INTO source_chunk_sets (
      id, source_version_id, source_id, user_id, parse_run_id, strategy,
      strategy_version, status, parent_count, child_count, created_at, activated_at
    ) VALUES (?, ?, ?, ?, ?, 'structure-recursive-parent-child', 'test-v1', 'ready', 2, 2, ?, ?)
  `).run(chunkSetId, versionId, sourceId, userId, parseRunId, now, now);
  paragraphs.forEach((paragraph, index) => {
    const parentId = `${sourceId}-parent-${index}`;
    const chunkId = `${sourceId}-chunk-${index}`;
    database.prepare(`
      INSERT INTO source_parent_chunks (
        id, chunk_set_id, source_version_id, source_id, user_id, position,
        heading, content, char_end, token_estimate, content_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 180, ?, ?)
    `).run(
      parentId, chunkSetId, versionId, sourceId, userId, index,
      `${title} 第 ${index + 1} 节`, paragraph, paragraph.length, `${parentId}-hash`, now,
    );
    database.prepare(`
      INSERT INTO source_chunks (
        id, chunk_set_id, parent_chunk_id, source_version_id, source_id, user_id,
        position, heading, context_prefix, content, char_end, token_estimate,
        node_start_position, node_end_position, content_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 80, ?, ?, ?, ?)
    `).run(
      chunkId, chunkSetId, parentId, versionId, sourceId, userId, index,
      `${title} 第 ${index + 1} 节`, `${title} > ${term}`, paragraph, paragraph.length,
      index, index, `${chunkId}-hash`, now,
    );
  });
  database.prepare(`
    UPDATE knowledge_sources SET active_chunk_set_id = ? WHERE id = ?
  `).run(chunkSetId, sourceId);
}

try {
  insertUser("user-a", "rag-user-a");
  insertUser("user-b", "rag-user-b");
  insertGoal("goal-a", "user-a", "学习检索系统");
  insertGoal("goal-legacy", "user-a", "没有学习画像的旧目标", false);
  insertGoal("goal-b", "user-b", "另一个用户的目标");
  insertSource({ sourceId: "source-alpha", userId: "user-a", title: "Alpha 资料", term: "alphaterm" });
  insertSource({ sourceId: "source-beta", userId: "user-a", title: "Beta 资料", term: "betaterm" });
  database.prepare(`
    INSERT INTO knowledge_sources (
      id, user_id, title, kind, content_hash, status, created_at, updated_at
    ) VALUES ('source-foreign', 'user-b', '别人的资料', 'text', 'foreign-hash', 'processing', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO goal_skills (
      id, goal_id, user_id, name, created_at, updated_at
    ) VALUES ('foreign-skill', 'goal-b', 'user-b', '别人的能力', ?, ?)
  `).run(now, now);

  const initial = readGoalSourceScope("user-a", "goal-a");
  assert(initial);
  assert.equal(initial.mode, "auto");
  assert.deepEqual(new Set(initial.includedSourceIds), new Set(["source-alpha", "source-beta"]));

  const excluded = updateGoalSourceScope({
    userId: "user-a",
    goalId: "goal-a",
    mode: "auto",
    excludedSourceIds: ["source-beta"],
  });
  assert.deepEqual(excluded.includedSourceIds, ["source-alpha"]);
  const excludedSearch = await searchGoalKnowledgeBase({
    userId: "user-a",
    goalId: "goal-a",
    purpose: "classroom_qa",
    mode: "fts5",
    query: "betaterm",
  });
  assert.equal(excludedSearch.resultCount, 0);
  assert.equal(excludedSearch.insufficiencyReason, "no_matching_evidence");

  updateGoalSourceScope({ userId: "user-a", goalId: "goal-a", mode: "auto" });
  const crossSource = await searchGoalKnowledgeBase({
    userId: "user-a",
    goalId: "goal-a",
    purpose: "lesson_generation",
    mode: "fts5",
    query: "betaterm",
    topK: 5,
    maxEvidenceTokens: 500,
    idempotencyKey: "workflow-retrieval-smoke-key",
  });
  assert.equal(crossSource.status, "sufficient");
  assert(crossSource.items.length >= 2);
  assert(crossSource.items.every((item) => item.sourceId === "source-beta"));
  assert(crossSource.totalEvidenceTokens <= crossSource.maxEvidenceTokens);
  assert.deepEqual(readWorkflowRetrievalSummary({
    userId: "user-a",
    goalId: "goal-a",
    idempotencyKey: "workflow-retrieval-smoke-key",
  }), {
    retrievalRunId: crossSource.retrievalRunId,
    status: "sufficient",
    resultCount: crossSource.resultCount,
    totalEvidenceTokens: crossSource.totalEvidenceTokens,
    insufficiencyReason: "",
  });

  // Retrieval hits must not silently become approved teaching evidence.
  for (const behavior of ['insufficient', 'unavailable', 'not_configured']) {
    reviewBehavior = behavior;
    const callsBefore = reviewCalls;
    if (behavior === 'not_configured') delete process.env.LLM_API_KEY;
    const rejected = await searchGoalKnowledgeBase({ userId: 'user-a', goalId: 'goal-a',
      purpose: 'lesson_generation', mode: 'fts5', query: 'betaterm', maxEvidenceTokens: 500 });
    assert.equal(rejected.status, 'insufficient');
    assert.equal(rejected.items.length, 0);
    assert.match(rejected.insufficiencyReason, behavior === 'insufficient'
      ? /teaching_evidence_insufficient/ : /teaching_review_unavailable/);
    assert.throws(() => readTutorEvidence('user-a', 'goal-a', rejected.retrievalRunId));
    if (behavior === 'not_configured') {
      assert.equal(reviewCalls, callsBefore);
      assert.match(rejected.insufficiencyReason, /llm_not_configured/);
    }
    process.env.LLM_API_KEY = 'test';
  }
  reviewBehavior = 'sufficient';

  const selected = updateGoalSourceScope({
    userId: "user-a",
    goalId: "goal-a",
    mode: "selected",
    includedSourceIds: ["source-alpha"],
  });
  assert.equal(selected.mode, "selected");
  assert.deepEqual(selected.includedSourceIds, ["source-alpha"]);
  const selectedSearch = await searchGoalKnowledgeBase({
    userId: "user-a",
    goalId: "goal-a",
    purpose: "classroom_qa",
    mode: "fts5",
    query: "betaterm",
  });
  assert.equal(selectedSearch.resultCount, 0);

  const budgeted = await searchGoalKnowledgeBase({
    userId: "user-a",
    goalId: "goal-a",
    purpose: "classroom_qa",
    mode: "fts5",
    query: "alphaterm",
    topK: 5,
    maxEvidenceTokens: 100,
  });
  assert.equal(budgeted.status, "sufficient");
  assert(budgeted.totalEvidenceTokens <= 100);

  const legacyScope = updateGoalSourceScope({
    userId: "user-a",
    goalId: "goal-legacy",
    mode: "selected",
    includedSourceIds: ["source-alpha"],
  });
  assert.equal(legacyScope.mode, "selected");
  assert.equal(
    database.prepare("SELECT source_scope_mode FROM goal_learning_profiles WHERE goal_id = 'goal-legacy'").get().source_scope_mode,
    "selected",
  );

  assert.throws(
    () => updateGoalSourceScope({
      userId: "user-a",
      goalId: "goal-a",
      mode: "selected",
      includedSourceIds: ["source-foreign"],
    }),
    (error) => error instanceof GoalSourceScopeError && error.status === 403,
  );
  await assert.rejects(
    () => searchGoalKnowledgeBase({
      userId: "user-a",
      goalId: "goal-a",
      skillId: "foreign-skill",
      purpose: "classroom_qa",
      mode: "fts5",
      query: "alphaterm",
    }),
    (error) => error instanceof KnowledgeRetrievalError && error.status === 403,
  );

  const audit = database.prepare(`
    SELECT goal_id, retrieval_mode, filters_json, total_evidence_tokens, status
    FROM retrieval_runs WHERE id = ?
  `).get(crossSource.retrievalRunId);
  const context = readTutorEvidence("user-a", "goal-a", crossSource.retrievalRunId);
  assert.equal(context.sources.length, crossSource.items.length);
  assert.equal(context.sources[0].snapshotText, crossSource.items[0].snapshotText);
  assert.throws(() => readTutorEvidence("user-b", "goal-a", crossSource.retrievalRunId));
  assert.throws(() => readTutorEvidence("user-a", "goal-legacy", crossSource.retrievalRunId));
  assert.throws(() => readTutorEvidence("user-a", "goal-a", budgeted.retrievalRunId));
  const draft = { blocks: [{ id: "b1", sourceChunkIds: [context.sources[0].chunkId] }] };
  assert.equal(checkLessonSources(draft, context).length, 0);
  assert.equal(checkLessonSources({ blocks: [{ id: "b1" }] }, context)[0].code, "source_missing");
  assert.equal(checkLessonSources({ blocks: [{ id: "b1", sourceChunkIds: ["foreign-chunk"] }] }, context)[0].code, "source_out_of_scope");
  const attached = attachLessonSources(draft, context);
  assert.equal(attached.sources.length, 1);
  assert.equal(attached.sourceStatus, "unverified", "valid IDs alone must not certify grounding");
  assert(!("snapshotText" in attached.sources[0]), "full evidence must not reach the client");
  assert(attached.sources[0].excerpt.length <= 600);
  const originalText = context.sources[0].snapshotText;
  database.prepare("UPDATE source_chunks SET content = 'changed after retrieval' WHERE id = ?").run(context.sources[0].chunkId);
  assert.equal(readTutorEvidence("user-a", "goal-a", crossSource.retrievalRunId).sources[0].snapshotText, originalText);
  assert.equal(audit.goal_id, "goal-a");
  assert.equal(audit.retrieval_mode, "fts5");
  assert.equal(audit.status, "completed");
  assert.equal(JSON.parse(audit.filters_json).purpose, "lesson_generation");
  assert.deepEqual(
    new Set(JSON.parse(audit.filters_json).sourceSnapshot.map((source) => source.sourceId)),
    new Set(["source-alpha", "source-beta"]),
  );
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM retrieval_run_items WHERE retrieval_run_id = ?").get(crossSource.retrievalRunId).count,
    crossSource.resultCount,
  );
  assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 0);

  console.log(JSON.stringify({
    autoScope: "ok",
    tutorEvidence: "ok",
    sourceGate: "ok",
    immutableEvidence: "ok",
    exclusions: "ok",
    selectedScope: "ok",
    legacyGoalProfile: "ok",
    ownershipIsolation: "ok",
    contextIsolation: "ok",
    crossSourceRetrieval: "ok",
    evidenceBudget: "ok",
    retrievalAudit: "ok",
    workflowReplay: "ok",
    teachingReviewBranches: "mock sufficient / insufficient / unavailable / no credentials",
  }));
} finally {
  globalThis.fetch = originalFetch;
  database.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
