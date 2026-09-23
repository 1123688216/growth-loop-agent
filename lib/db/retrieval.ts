import { createHash, randomUUID } from "node:crypto";
import { ragflowEndpoint, retrieveRagflow } from '../knowledge/ragflow-client.ts';
import { configuredEmbeddingModel } from '../knowledge/embedding-config.ts';
import { rankWithLlamaIndex } from '../knowledge/llamaindex-client.ts';
import { reviewTeachingEvidence } from "../knowledge/evidence-review.ts";

import { embedTexts, EmbeddingServiceError } from "../knowledge/embedding-client.ts";
import {
  EMBEDDING_PROFILE_DEFINITIONS,
  embeddingProfileId,
  type EmbeddingModelAlias,
} from "../knowledge/embedding-profiles.ts";
import { resolveGoalSources } from "./goal-sources.ts";
import { getDatabase, withTransaction } from "./index.ts";
import {
  beginPipelineRun,
  completePipelineRun,
  failPipelineRun,
  recordPipelineStage,
} from "./pipeline-metrics.ts";

export type KnowledgeSearchPurpose = "lesson_generation" | "classroom_qa";
export type KnowledgeSearchMode = "auto" | "vector" | "fts5";

type RetrievalMode = "vector_exact" | "fts5" | "fts5_fallback" | "ragflow";

type ProfileRow = {
  id: string;
  model: string;
  model_revision: string;
  dimension: number;
};

type RetrievalCandidate = {
  id: string;
  source_id: string;
  source_title: string;
  source_version_id: string;
  chunk_set_id: string;
  parent_chunk_id: string;
  heading: string;
  context_prefix: string;
  content: string;
  page_start: number | null;
  page_end: number | null;
  token_estimate: number;
  parent_heading: string;
  parent_content: string;
  parent_token_estimate: number;
  vector_blob?: Uint8Array;
  dimension?: number;
};

type ScoredCandidate = {
  candidate: RetrievalCandidate;
  score: number;
};

export type EvidenceItem = {
  rank: number;
  score: number;
  sourceId: string;
  sourceTitle: string;
  sourceVersionId: string;
  chunkSetId: string;
  chunkId: string;
  parentId: string;
  heading: string;
  parentHeading: string;
  pageStart: number | null;
  pageEnd: number | null;
  excerpt: string;
  snapshotText: string;
  snapshotHash: string;
  tokenEstimate: number;
};

export type EvidenceBundle = {
  retrievalRunId: string;
  pipelineRunId: string;
  traceId: string;
  goalId: string;
  lessonId: string | null;
  skillId: string | null;
  purpose: KnowledgeSearchPurpose;
  sourceScopeMode: "auto" | "selected";
  requestedMode: KnowledgeSearchMode;
  retrievalMode: RetrievalMode;
  model: EmbeddingModelAlias | null;
  query: string;
  status: "sufficient" | "insufficient";
  insufficiencyReason: string;
  missingTopics?: string[];
  candidateSourceCount: number;
  readySourceCount: number;
  resultCount: number;
  totalEvidenceTokens: number;
  maxEvidenceTokens: number;
  items: EvidenceItem[];
  unavailableSources: Array<{ sourceId: string; title: string; reason: string }>;
  degradedReason: string;
  durationMs: number;
};

export class KnowledgeRetrievalError extends Error {
  readonly status: number;

  constructor(message: string, status = 422) {
    super(message);
    this.status = status;
  }
}

/** Load immutable evidence, with ownership checked before exposing any source text. */
export function readTutorEvidence(userId: string, goalId: string, retrievalRunId: string) {
  const database = getDatabase();
  const run = database.prepare(`SELECT id FROM retrieval_runs
    WHERE id = ? AND user_id = ? AND goal_id = ? AND status = 'completed'
      AND insufficiency_reason = ''
      AND json_extract(filters_json, '$.semanticReview.version') = 'teaching-relevance-v1'
      AND json_extract(filters_json, '$.semanticReview.sufficient') = 1
      AND json_extract(filters_json, '$.purpose') = 'lesson_generation'`).get(retrievalRunId, userId, goalId);
  if (!run) throw new KnowledgeRetrievalError("资料不足、检索记录不属于当前目标，或旧证据尚未通过教学相关性审核；请重新检索。", 422);
  const rows = database.prepare(`SELECT i.chunk_id, i.snapshot_text, i.snapshot_hash, i.excerpt,
    s.title, c.heading, c.page_start, c.page_end
    FROM retrieval_run_items i JOIN source_chunks c ON c.id = i.chunk_id
    JOIN knowledge_sources s ON s.id = i.source_id
    WHERE i.retrieval_run_id = ? AND s.user_id = ? ORDER BY i.rank`).all(retrievalRunId, userId) as Array<{
      chunk_id: string; snapshot_text: string; snapshot_hash: string; excerpt: string;
      title: string; heading: string; page_start: number | null; page_end: number | null;
    }>;
  if (!rows.length) throw new KnowledgeRetrievalError("资料不足：检索快照没有可用证据。", 422);
  if (rows.some((row) => sha256(row.snapshot_text) !== row.snapshot_hash)) {
    throw new KnowledgeRetrievalError("检索证据快照完整性校验失败。", 422);
  }
  return {
    retrievalRunId,
    sources: rows.map((row) => ({ chunkId: row.chunk_id, snapshotText: row.snapshot_text,
      snapshotHash: row.snapshot_hash, excerpt: row.excerpt, sourceTitle: row.title,
      heading: row.heading, pageStart: row.page_start, pageEnd: row.page_end })),
  };
}

export type WorkflowRetrievalSummary = {
  retrievalRunId: string;
  status: "sufficient" | "insufficient";
  resultCount: number;
  totalEvidenceTokens: number;
  insufficiencyReason: string;
};

/**
 * Recovers the durable result after a process dies between persisting a
 * RetrievalRun and caching the surrounding workflow action result.
 */
export function readWorkflowRetrievalSummary(input: {
  userId: string;
  goalId: string;
  idempotencyKey: string;
}): WorkflowRetrievalSummary | null {
  const key = input.idempotencyKey.trim().slice(0, 240);
  if (!key) return null;
  const row = getDatabase().prepare(`
    SELECT id, result_count, total_evidence_tokens, insufficiency_reason
    FROM retrieval_runs
    WHERE user_id = ? AND goal_id = ? AND status = 'completed'
      AND json_extract(filters_json, '$.workflowIdempotencyKey') = ?
    ORDER BY created_at DESC LIMIT 1
  `).get(input.userId, input.goalId, key) as {
    id: string;
    result_count: number;
    total_evidence_tokens: number;
    insufficiency_reason: string;
  } | undefined;
  if (!row) return null;
  return {
    retrievalRunId: row.id,
    status: row.insufficiency_reason ? "insufficient" : "sufficient",
    resultCount: row.result_count,
    totalEvidenceTokens: row.total_evidence_tokens,
    insufficiencyReason: row.insufficiency_reason,
  };
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function decodeVector(blob: Uint8Array, dimension: number) {
  if (blob.byteLength !== dimension * Float32Array.BYTES_PER_ELEMENT) {
    throw new KnowledgeRetrievalError("数据库中的向量维度已损坏。", 500);
  }
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer);
}

function clampInteger(value: number | undefined, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, Math.floor(parsed))) : fallback;
}

function ftsQuery(value: string) {
  const terms = value
    .normalize("NFKC")
    .split(/[\s,，。；;：:、!?！？()（）\[\]{}<>《》]+/u)
    .map((term) => term.trim().replaceAll('"', '""'))
    .filter((term) => term.length >= 2)
    .slice(0, 12);
  return terms.map((term) => `"${term}"`).join(" OR ");
}

function placeholders(count: number) {
  return Array.from({ length: count }, () => "?").join(", ");
}

function selectEvidence(input: {
  scored: ScoredCandidate[];
  topK: number;
  maxEvidenceTokens: number;
}) {
  const selected: EvidenceItem[] = [];
  const seenParents = new Set<string>();
  const sourceCounts = new Map<string, number>();
  // Diversity is useful across multiple documents; a single selected textbook
  // must not lose half its evidence budget merely because it is one source.
  const sourceCount = new Set(input.scored.map(item => item.candidate.source_id)).size;
  const maxPerSource = sourceCount <= 1 ? input.topK : Math.max(2, Math.ceil(input.topK / 2));
  let remainingTokens = input.maxEvidenceTokens;

  for (const item of input.scored) {
    const candidate = item.candidate;
    if (seenParents.has(candidate.parent_chunk_id)) continue;
    if ((sourceCounts.get(candidate.source_id) || 0) >= maxPerSource) continue;
    if (remainingTokens < 100) break;

    const requestedTokens = Math.max(1, candidate.parent_token_estimate);
    const selectedTokens = Math.min(requestedTokens, remainingTokens);
    const snapshotText = requestedTokens <= remainingTokens
      ? candidate.parent_content
      : candidate.parent_content.slice(0, Math.max(400, selectedTokens * 4)).trimEnd();
    if (!snapshotText) continue;
    const actualTokens = Math.min(selectedTokens, Math.max(1, Math.ceil(snapshotText.length / 4)));

    seenParents.add(candidate.parent_chunk_id);
    sourceCounts.set(candidate.source_id, (sourceCounts.get(candidate.source_id) || 0) + 1);
    remainingTokens -= actualTokens;
    selected.push({
      rank: selected.length + 1,
      score: item.score,
      sourceId: candidate.source_id,
      sourceTitle: candidate.source_title,
      sourceVersionId: candidate.source_version_id,
      chunkSetId: candidate.chunk_set_id,
      chunkId: candidate.id,
      parentId: candidate.parent_chunk_id,
      heading: candidate.heading,
      parentHeading: candidate.parent_heading,
      pageStart: candidate.page_start,
      pageEnd: candidate.page_end,
      excerpt: candidate.content,
      snapshotText,
      snapshotHash: sha256(snapshotText),
      tokenEstimate: actualTokens,
    });
    if (selected.length >= input.topK) break;
  }
  return selected;
}

function coverage(input: { purpose: KnowledgeSearchPurpose; readySourceCount: number; items: EvidenceItem[] }) {
  if (input.readySourceCount === 0) return { status: "insufficient" as const, reason: "no_ready_sources" };
  if (input.items.length === 0) return { status: "insufficient" as const, reason: "no_matching_evidence" };
  const tokens = input.items.reduce((total, item) => total + item.tokenEstimate, 0);
  if (input.purpose === "lesson_generation" && input.items.length < 2 && tokens < 300) {
    return { status: "insufficient" as const, reason: "insufficient_lesson_evidence" };
  }
  return { status: "sufficient" as const, reason: "" };
}

function validateRetrievalContext(input: {
  userId: string;
  goalId: string;
  lessonId?: string | null;
  skillId?: string | null;
}) {
  const database = getDatabase();
  if (input.lessonId) {
    const lesson = database.prepare(`
      SELECT 1
      FROM course_lessons AS lesson
      JOIN learning_programs AS program ON program.id = lesson.program_id
      WHERE lesson.id = ? AND program.goal_id = ? AND program.user_id = ?
    `).get(input.lessonId, input.goalId, input.userId);
    if (!lesson) throw new KnowledgeRetrievalError("课节不属于当前学习目标。", 403);
  }
  if (input.skillId) {
    const skill = database.prepare(`
      SELECT 1 FROM goal_skills
      WHERE id = ? AND goal_id = ? AND user_id = ? AND status = 'active'
    `).get(input.skillId, input.goalId, input.userId);
    if (!skill) throw new KnowledgeRetrievalError("能力点不属于当前学习目标。", 403);
  }
}

function persistRetrieval(input: {
  retrievalRunId: string;
  userId: string;
  goalId: string;
  lessonId?: string | null;
  skillId?: string | null;
  pipelineRunId: string;
  profileId?: string | null;
  retrievalMode: RetrievalMode;
  query: string;
  filters: Record<string, unknown>;
  topK: number;
  maxEvidenceTokens: number;
  items: EvidenceItem[];
  insufficiencyReason: string;
  durationMs: number;
  createdAt: string;
}) {
  const totalEvidenceTokens = input.items.reduce((total, item) => total + item.tokenEstimate, 0);
  withTransaction((database) => {
    database.prepare(`
      INSERT INTO retrieval_runs (
        id, user_id, goal_id, lesson_id, skill_id, pipeline_run_id, embedding_profile_id,
        retrieval_mode, query, filters_json, top_k, max_evidence_tokens, result_count,
        total_evidence_tokens, status, insufficiency_reason, latency_ms, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?)
    `).run(
      input.retrievalRunId, input.userId, input.goalId, input.lessonId || null, input.skillId || null,
      input.pipelineRunId, input.profileId || null, input.retrievalMode, input.query,
      JSON.stringify(input.filters), input.topK, input.maxEvidenceTokens, input.items.length,
      totalEvidenceTokens, input.insufficiencyReason, Math.max(0, Math.round(input.durationMs)), input.createdAt,
    );
    const insert = database.prepare(`
      INSERT INTO retrieval_run_items (
        id, retrieval_run_id, source_id, source_version_id, chunk_id, rank,
        score, excerpt, snapshot_text, snapshot_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    input.items.forEach((item) => insert.run(
      randomUUID(), input.retrievalRunId, item.sourceId, item.sourceVersionId, item.chunkId,
      item.rank, item.score, item.excerpt, item.snapshotText, item.snapshotHash, input.createdAt,
    ));
  });
}

function vectorCompleteness(input: {
  userId: string;
  profileId: string;
  sources: Array<{ id: string; activeChunkSetId: string | null; chunkCount: number }>;
}) {
  if (!input.sources.length) return false;
  const count = getDatabase().prepare(`
    SELECT COUNT(*) AS count
    FROM source_chunk_embeddings
    WHERE user_id = ? AND source_id = ? AND chunk_set_id = ? AND profile_id = ?
  `);
  return input.sources.every((source) => source.activeChunkSetId
    && Number((count.get(input.userId, source.id, source.activeChunkSetId, input.profileId) as { count: number }).count) >= source.chunkCount);
}

function readVectorCandidates(input: {
  userId: string;
  profileId: string;
  sourceIds: string[];
}) {
  return getDatabase().prepare(`
    SELECT sc.id, sc.source_id, ks.title AS source_title, sc.source_version_id,
           sc.chunk_set_id, sc.parent_chunk_id, sc.heading, sc.context_prefix,
           sc.content, sc.page_start, sc.page_end, sc.token_estimate,
           pc.heading AS parent_heading, pc.content AS parent_content,
           pc.token_estimate AS parent_token_estimate,
           sce.vector_blob, sce.dimension
    FROM source_chunk_embeddings AS sce
    JOIN source_chunks AS sc ON sc.id = sce.chunk_id
    JOIN source_parent_chunks AS pc ON pc.id = sc.parent_chunk_id
    JOIN knowledge_sources AS ks ON ks.id = sc.source_id
    WHERE sce.user_id = ? AND sce.profile_id = ?
      AND sce.source_id IN (${placeholders(input.sourceIds.length)})
      AND ks.user_id = ? AND ks.status = 'ready' AND ks.deleted_at IS NULL
      AND ks.active_chunk_set_id = sce.chunk_set_id AND sc.chunk_set_id = sce.chunk_set_id
  `).all(input.userId, input.profileId, ...input.sourceIds, input.userId) as RetrievalCandidate[];
}

function readFtsCandidates(input: { userId: string; sourceIds: string[]; query: string; limit: number }) {
  const match = ftsQuery(input.query);
  if (!match) return [];
  return getDatabase().prepare(`
    SELECT sc.id, sc.source_id, ks.title AS source_title, sc.source_version_id,
           sc.chunk_set_id, sc.parent_chunk_id, sc.heading, sc.context_prefix,
           sc.content, sc.page_start, sc.page_end, sc.token_estimate,
           pc.heading AS parent_heading, pc.content AS parent_content,
           pc.token_estimate AS parent_token_estimate,
           bm25(source_chunks_fts) AS fts_score
    FROM source_chunks_fts
    JOIN source_chunks AS sc ON sc.id = source_chunks_fts.chunk_id
    JOIN source_parent_chunks AS pc ON pc.id = sc.parent_chunk_id
    JOIN knowledge_sources AS ks ON ks.id = sc.source_id
    WHERE source_chunks_fts MATCH ? AND source_chunks_fts.user_id = ?
      AND source_chunks_fts.source_id IN (${placeholders(input.sourceIds.length)})
      AND ks.user_id = ? AND ks.status = 'ready' AND ks.deleted_at IS NULL
      AND ks.active_chunk_set_id = sc.chunk_set_id
    ORDER BY bm25(source_chunks_fts), sc.position
    LIMIT ?
  `).all(match, input.userId, ...input.sourceIds, input.userId, input.limit) as Array<RetrievalCandidate & { fts_score: number }>;
}

type RagflowBinding = { source_id: string; dataset_id: string; document_id: string; endpoint: string };

function readRagflowBindings(userId: string, sourceIds: string[]) {
  if (!sourceIds.length) return [];
  return getDatabase().prepare(`SELECT ks.id AS source_id,
    json_extract(cs.config_json, '$.ragflow.datasetId') AS dataset_id,
    json_extract(cs.config_json, '$.ragflow.documentId') AS document_id,
    json_extract(cs.config_json, '$.ragflow.endpoint') AS endpoint
    FROM knowledge_sources ks JOIN source_chunk_sets cs ON cs.id = ks.active_chunk_set_id
    WHERE ks.user_id = ? AND ks.id IN (${placeholders(sourceIds.length)})
      AND cs.strategy = 'ragflow' AND ks.status = 'ready' AND ks.deleted_at IS NULL`
  ).all(userId, ...sourceIds) as RagflowBinding[];
}

async function readRagflowCandidates(userId: string, bindings: RagflowBinding[], query: string, topK: number, targetTopics?: string[]) {
  const scored: ScoredCandidate[] = [];
  const endpoint = ragflowEndpoint();
  if (bindings.some(b => b.endpoint !== endpoint)) throw new KnowledgeRetrievalError('RAGFlow 地址与已绑定资料不一致，请检查配置。', 409);
  for (const datasetId of new Set(bindings.map(b => b.dataset_id))) {
    const group = bindings.filter(b => b.dataset_id === datasetId);
    const chunks = await retrieveRagflow({ datasetId, documentIds: group.map(b => b.document_id), query, topK, targetTopics });
    for (const chunk of chunks) {
      const binding = group.find(b => b.document_id === chunk.document_id)!;
      const candidate = getDatabase().prepare(`SELECT sc.id, sc.source_id, ks.title AS source_title,
        sc.source_version_id, sc.chunk_set_id, sc.parent_chunk_id, sc.heading, sc.context_prefix,
        sc.content, sc.page_start, sc.page_end, sc.token_estimate,
        pc.heading AS parent_heading, pc.content AS parent_content, pc.token_estimate AS parent_token_estimate
        FROM source_chunks sc JOIN knowledge_sources ks ON ks.id = sc.source_id
        JOIN source_parent_chunks pc ON pc.id = sc.parent_chunk_id
        WHERE ks.user_id = ? AND ks.id = ? AND ks.active_chunk_set_id = sc.chunk_set_id
          AND ks.status = 'ready' AND ks.deleted_at IS NULL
          AND json_extract(sc.boundary_reason_json, '$.ragflowChunkId') = ?`
      ).get(userId, binding.source_id, chunk.id) as RetrievalCandidate | undefined;
      // Remote reparsing must not silently attach new text to an old citation ID.
      if (!candidate || candidate.content !== chunk.content) {
        throw new KnowledgeRetrievalError('RAGFlow 文档片段已变更，请重新绑定最新文档快照后检索。', 409);
      }
      scored.push({ candidate, score: chunk.similarity! });
    }
  }
  // Preserve the adapter's topic-balanced order for a single dataset.
  return new Set(bindings.map(b => b.dataset_id)).size === 1 ? scored : scored.sort((a, b) => b.score - a.score);
}

export async function searchGoalKnowledgeBase(input: {
  lessonScope?: {title:string;objective:string};
  userId: string;
  goalId: string;
  lessonId?: string | null;
  skillId?: string | null;
  query: string;
  targetTopics?: string[];
  purpose: KnowledgeSearchPurpose;
  mode?: KnowledgeSearchMode;
  model?: EmbeddingModelAlias;
  topK?: number;
  maxEvidenceTokens?: number;
  /** Trusted orchestration key used only for crash-safe replay lookup. */
  idempotencyKey?: string;
  knowledgeNeed?: 'verify' | 'current' | 'source_required';
}): Promise<EvidenceBundle> {
  const query = input.query.trim().slice(0, 2_000);
  if (!query) throw new KnowledgeRetrievalError("请输入要检索的问题。", 400);
  if (input.purpose !== "lesson_generation" && input.purpose !== "classroom_qa") {
    throw new KnowledgeRetrievalError("检索用途不正确。", 400);
  }

  const requestedMode = input.mode || "auto";
  const model = input.model ?? configuredEmbeddingModel();
  let topK = clampInteger(input.topK, input.purpose === "lesson_generation" ? 8 : 5, 1, 20);
  const maxEvidenceTokens = clampInteger(
    input.maxEvidenceTokens,
    input.purpose === "lesson_generation" ? 2_400 : 1_600,
    100,
    20_000,
  );
  const scope = resolveGoalSources(input.userId, input.goalId);
  validateRetrievalContext(input);
  const unavailableSources = scope.sources
    .filter((source) => source.status !== "ready" || !source.activeChunkSetId || source.chunkCount === 0)
    .map((source) => ({
      sourceId: source.id,
      title: source.title,
      reason: source.status !== "ready" ? source.status : "missing_active_chunks",
    }));
  const readySources = scope.sources.filter((source) => source.status === "ready" && source.activeChunkSetId && source.chunkCount > 0);
  const sourceIds = readySources.map((source) => source.id);
  const ragflowBindings = readRagflowBindings(input.userId, sourceIds);
  // RAGFlow snippets may be much shorter than legacy parent chunks. Use more
  // candidates for lesson coverage without increasing the evidence token budget.
  if (ragflowBindings.length && input.topK === undefined && input.purpose === 'lesson_generation') topK = 20;
  const sourceSnapshot = readySources.map((source) => ({
    sourceId: source.id,
    sourceVersionId: source.currentVersionId,
    chunkSetId: source.activeChunkSetId,
  }));

  const profileId = embeddingProfileId(model);
  const profile = getDatabase().prepare(`
    SELECT id, model, model_revision, dimension
    FROM embedding_profiles WHERE id = ? AND status = 'active'
  `).get(profileId) as ProfileRow | undefined;
  const vectorsComplete = Boolean(profile) && vectorCompleteness({
    userId: input.userId,
    profileId,
    sources: readySources,
  });
  let retrievalMode: RetrievalMode = ragflowBindings.length ? "ragflow" : requestedMode === "fts5"
    ? "fts5"
    : requestedMode === "vector"
      ? "vector_exact"
      : vectorsComplete ? "vector_exact" : "fts5";
  if (!ragflowBindings.length && requestedMode === "vector" && (!profile || !vectorsComplete)) {
    throw new KnowledgeRetrievalError("目标范围内仍有资料没有完成所选模型的向量化。", 409);
  }

  const pipeline = beginPipelineRun({
    userId: input.userId,
    operation: "retrieval",
    profileId: profile?.id || null,
    config: { goalId: input.goalId, purpose: input.purpose, requestedMode, topK, maxEvidenceTokens, sourceSnapshot },
  });
  const retrievalRunId = randomUUID();
  const createdAt = new Date().toISOString();
  let degradedReason = "";
  let scored: ScoredCandidate[] = [];
  let currentStage = "retrieval.scope";
  let persisted = false;
  try {
    recordPipelineStage({
      pipelineRunId: pipeline.id,
      stage: currentStage,
      inputCount: scope.sources.length,
      outputCount: readySources.length,
      metadata: { scopeMode: scope.mode, unavailableSources },
    });

    if (retrievalMode === 'ragflow') {
      currentStage = 'retrieval.ragflow';
      const started = performance.now();
      scored = await readRagflowCandidates(input.userId, ragflowBindings, query, Math.max(topK * 3, 20), input.targetTopics);
      recordPipelineStage({ pipelineRunId: pipeline.id, stage: currentStage,
        wallDurationMs: performance.now() - started, inputCount: ragflowBindings.length,
        outputCount: scored.length, provider: 'ragflow', metadata: { bindings: ragflowBindings } });
      // Legacy uploads / web supplements remain searchable during the upload migration.
      // Do not mix old vector profiles with RAGFlow's own query embeddings.
      const legacyIds = sourceIds.filter(id => !ragflowBindings.some(b => b.source_id === id));
      if (legacyIds.length) {
        scored.push(...readFtsCandidates({ userId: input.userId, sourceIds: legacyIds, query, limit: topK * 3 })
          .map(candidate => ({ candidate, score: -candidate.fts_score })));
        degradedReason = 'legacy_sources_fts5_after_ragflow';
      }
    }

    if (readySources.length && retrievalMode === "vector_exact" && profile) {
      currentStage = "retrieval.query_encode";
      try {
        const embedded = await embedTexts({ model, inputType: "query", texts: [query] });
        const definition = EMBEDDING_PROFILE_DEFINITIONS[model];
        if (embedded.model !== definition.model || embedded.revision !== definition.revision
          || embedded.dimension !== profile.dimension || !embedded.normalized || embedded.vectors.length !== 1) {
          throw new KnowledgeRetrievalError("Embedding 服务返回的模型或向量契约不一致。", 502);
        }
        recordPipelineStage({
          pipelineRunId: pipeline.id,
          stage: currentStage,
          wallDurationMs: embedded.timing.serviceRoundtripMs,
          computeDurationMs: embedded.timing.encodeMs,
          inputCount: 1,
          outputCount: 1,
          inputTokens: embedded.inputTokens,
          cacheState: embedded.timing.modelLoadMs > 0 ? "cold" : "warm",
          provider: definition.provider,
          model: embedded.model,
          modelRevision: embedded.revision,
          device: embedded.device,
          batchSize: 1,
          metadata: { tokenizeMs: embedded.timing.tokenizeMs, modelLoadMs: embedded.timing.modelLoadMs },
        });
        currentStage = "retrieval.vector";
        const started = performance.now();
        const candidates = readVectorCandidates({ userId: input.userId, profileId: profile.id, sourceIds });
        scored = await rankWithLlamaIndex(model, embedded.vectors[0], candidates,
          candidate => decodeVector(candidate.vector_blob!, candidate.dimension!));
        recordPipelineStage({
          pipelineRunId: pipeline.id,
          stage: currentStage,
          wallDurationMs: performance.now() - started,
          computeDurationMs: performance.now() - started,
          inputCount: candidates.length,
          outputCount: scored.length,
          provider: "llamaindex-sqlite-snapshot",
          model: profile.model,
          modelRevision: profile.model_revision,
        });
      } catch (error) {
        if (requestedMode !== "auto") throw error;
        degradedReason = error instanceof Error ? error.message : "vector_query_failed";
        try {
          recordPipelineStage({
            pipelineRunId: pipeline.id,
            stage: currentStage,
            status: "failed",
            wallDurationMs: performance.now() - pipeline.startedMonotonicMs,
            errorCode: error instanceof EmbeddingServiceError ? "EMBEDDING_SERVICE_ERROR" : "VECTOR_QUERY_ERROR",
            errorMessage: degradedReason,
          });
        } catch {
          // The fallback still needs a chance to complete.
        }
        retrievalMode = "fts5_fallback";
      }
    }

    if (readySources.length && retrievalMode !== "vector_exact" && retrievalMode !== 'ragflow') {
      currentStage = "retrieval.fts5";
      const started = performance.now();
      const candidates = readFtsCandidates({
        userId: input.userId,
        sourceIds,
        query,
        limit: Math.max(30, topK * 5),
      });
      scored = candidates.map((candidate) => ({ candidate, score: -candidate.fts_score }));
      recordPipelineStage({
        pipelineRunId: pipeline.id,
        stage: currentStage,
        wallDurationMs: performance.now() - started,
        computeDurationMs: performance.now() - started,
        inputCount: readySources.reduce((total, source) => total + source.chunkCount, 0),
        outputCount: scored.length,
        provider: "sqlite-fts5",
        metadata: { degradedReason },
      });
    }

    currentStage = "retrieval.evidence_bundle";
    const bundleStarted = performance.now();
    let items = selectEvidence({ scored, topK, maxEvidenceTokens });
    let resultCoverage = coverage({ purpose: input.purpose, readySourceCount: readySources.length, items });
    let semanticReview: Record<string, unknown> | null = null;
    if ((input.purpose === "lesson_generation" || input.knowledgeNeed) && items.length) {
      currentStage = "retrieval.teaching_review";
      const reviewStarted = performance.now();
      const goal = getDatabase().prepare("SELECT title, description FROM goals WHERE id = ? AND user_id = ?")
        .get(input.goalId, input.userId) as { title: string; description: string } | undefined;
      if (!goal) throw new KnowledgeRetrievalError("找不到当前学习目标。", 404);
      const review = await reviewTeachingEvidence({ goal, query, items, lessonScope:input.lessonScope,
        knowledgeNeed: input.knowledgeNeed, reviewedAt: new Date().toISOString() });
      semanticReview = { version: "teaching-relevance-v1", ...review.data, mode: review.mode,
        fallbackReason: review.fallbackReason, latencyMs: review.latencyMs, usage: review.usage };
      const kept = new Set(review.data.relevantChunkIds);
      items = items.filter((item) => kept.has(item.chunkId)).map((item, index) => ({ ...item, rank: index + 1 }));
      resultCoverage = review.mode === "llm" && review.data.sufficient
        ? coverage({ purpose: input.purpose, readySourceCount: readySources.length, items })
        : { status: "insufficient", reason: review.mode !== "llm"
          ? `teaching_review_unavailable：${review.fallbackReason}`
          : `teaching_evidence_insufficient：${review.data.reason} ${review.data.missingTopics.join("、")}` };
      recordPipelineStage({ pipelineRunId: pipeline.id, stage: currentStage,
        wallDurationMs: performance.now() - reviewStarted, provider: review.provider, model: review.model,
        outputCount: items.length, metadata: semanticReview });
    }
    currentStage = "retrieval.evidence_bundle";
    const totalEvidenceTokens = items.reduce((total, item) => total + item.tokenEstimate, 0);
    const durationMs = performance.now() - pipeline.startedMonotonicMs;
    persistRetrieval({
      retrievalRunId,
      userId: input.userId,
      goalId: input.goalId,
      lessonId: input.lessonId,
      skillId: input.skillId,
      pipelineRunId: pipeline.id,
      profileId: retrievalMode === "vector_exact" ? profile?.id : null,
      retrievalMode,
      query,
      filters: {
        purpose: input.purpose,
        workflowIdempotencyKey: input.idempotencyKey?.trim().slice(0, 240) || "",
        scopeMode: scope.mode,
        sourceSnapshot,
        unavailableSources,
        degradedReason,
        semanticReview,
        ragflowBindings,
        targetTopics: input.targetTopics,
        lessonScope: input.lessonScope,
      },
      topK,
      maxEvidenceTokens,
      items,
      insufficiencyReason: resultCoverage.reason,
      durationMs,
      createdAt,
    });
    persisted = true;
    recordPipelineStage({
      pipelineRunId: pipeline.id,
      stage: currentStage,
      wallDurationMs: performance.now() - bundleStarted,
      computeDurationMs: performance.now() - bundleStarted,
      inputCount: scored.length,
      outputCount: items.length,
      outputTokens: totalEvidenceTokens,
      metadata: { coverageStatus: resultCoverage.status, insufficiencyReason: resultCoverage.reason },
    });
    completePipelineRun(pipeline.id, pipeline.startedMonotonicMs);
    return {
      retrievalRunId,
      pipelineRunId: pipeline.id,
      traceId: pipeline.traceId,
      goalId: input.goalId,
      lessonId: input.lessonId || null,
      skillId: input.skillId || null,
      purpose: input.purpose,
      sourceScopeMode: scope.mode,
      requestedMode,
      retrievalMode,
      model: retrievalMode === "vector_exact" ? model : null,
      query,
      status: resultCoverage.status,
      insufficiencyReason: resultCoverage.reason,
      candidateSourceCount: scope.sources.length,
      missingTopics: semanticReview ? semanticReview.missingTopics as string[] : [query],
      readySourceCount: readySources.length,
      resultCount: items.length,
      totalEvidenceTokens,
      maxEvidenceTokens,
      items,
      unavailableSources,
      degradedReason,
      durationMs,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "知识库检索失败。";
    if (!persisted) {
      try {
        getDatabase().prepare(`
          INSERT INTO retrieval_runs (
            id, user_id, goal_id, lesson_id, skill_id, pipeline_run_id, embedding_profile_id,
            retrieval_mode, query, filters_json, top_k, max_evidence_tokens, result_count,
            total_evidence_tokens, status, insufficiency_reason, latency_ms, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'failed', ?, ?, ?)
        `).run(
          retrievalRunId, input.userId, input.goalId, input.lessonId || null, input.skillId || null,
          pipeline.id, profile?.id || null, retrievalMode, query,
          JSON.stringify({ purpose: input.purpose, scopeMode: scope.mode, sourceSnapshot }),
          topK, maxEvidenceTokens, message.slice(0, 2_000),
          Math.round(performance.now() - pipeline.startedMonotonicMs), createdAt,
        );
      } catch {
        // A database error can also prevent writing the audit row.
      }
    }
    failPipelineRun({
      id: pipeline.id,
      startedMonotonicMs: pipeline.startedMonotonicMs,
      errorCode: error instanceof EmbeddingServiceError ? "EMBEDDING_SERVICE_ERROR" : "KNOWLEDGE_RETRIEVAL_ERROR",
      errorMessage: message,
    });
    throw error;
  }
}
