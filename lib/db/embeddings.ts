import { createHash, randomUUID } from "node:crypto";
import { configuredEmbeddingModel } from '../knowledge/embedding-config.ts';
import { rankWithLlamaIndex } from '../knowledge/llamaindex-client.ts';
import { getDatabase, withTransaction } from "./index.ts";
import {
  beginPipelineRun,
  completePipelineRun,
  failPipelineRun,
  recordPipelineStage,
} from "./pipeline-metrics.ts";
import { embedTexts, EmbeddingServiceError } from "../knowledge/embedding-client.ts";
import {
  EMBEDDING_MODEL_ALIASES,
  EMBEDDING_PROFILE_DEFINITIONS,
  embeddingProfileId,
  type EmbeddingModelAlias,
} from "../knowledge/embedding-profiles.ts";

type SourceRow = {
  id: string;
  title: string;
  active_chunk_set_id: string;
};

type ChunkRow = {
  id: string;
  chunk_set_id: string;
  source_version_id: string;
  source_id: string;
  position: number;
  parent_chunk_id: string;
  heading: string;
  context_prefix: string;
  content: string;
  token_estimate: number;
  content_hash: string;
};

type CandidateRow = ChunkRow & {
  vector_blob: Uint8Array;
  dimension: number;
  parent_heading: string;
  parent_content: string;
  parent_token_estimate: number;
  parent_content_hash: string;
};

type ProfileRow = {
  id: string;
  model_alias: EmbeddingModelAlias;
  model: string;
  model_revision: string;
  dimension: number;
};

export type EmbeddingIndexSummary = {
  runId: string;
  pipelineRunId: string;
  traceId: string;
  profileId: string;
  model: EmbeddingModelAlias;
  totalCount: number;
  embeddedCount: number;
  reusedCount: number;
  device: string;
  dtype: string;
  durationMs: number;
  timing: {
    modelLoadMs: number;
    tokenizeMs: number;
    encodeMs: number;
    serviceRoundtripMs: number;
    persistMs: number;
  };
};

export type VectorSearchResult = {
  rank: number;
  score: number;
  chunkId: string;
  parentId: string;
  heading: string;
  contextPrefix: string;
  excerpt: string;
  parentHeading: string;
  parentContent: string;
  tokenEstimate: number;
};

export class EmbeddingIndexError extends Error {
  readonly status: number;

  constructor(message: string, status = 422) {
    super(message);
    this.status = status;
  }
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "未知错误";
}

function sourceForUser(userId: string, sourceId: string): SourceRow | null {
  const row = getDatabase().prepare(`
    SELECT id, title, active_chunk_set_id
    FROM knowledge_sources
    WHERE id = ? AND user_id = ? AND status = 'ready' AND deleted_at IS NULL
  `).get(sourceId, userId) as SourceRow | undefined;
  return row || null;
}

function activeChunks(userId: string, source: SourceRow): ChunkRow[] {
  return getDatabase().prepare(`
    SELECT id, chunk_set_id, source_version_id, source_id, position, parent_chunk_id,
           heading, context_prefix, content, token_estimate, content_hash
    FROM source_chunks
    WHERE user_id = ? AND source_id = ? AND chunk_set_id = ?
    ORDER BY position
  `).all(userId, source.id, source.active_chunk_set_id) as ChunkRow[];
}

function documentText(chunk: ChunkRow) {
  return [chunk.context_prefix.trim(), chunk.content.trim()].filter(Boolean).join("\n\n");
}

function profileIdFor(alias: EmbeddingModelAlias) {
  return embeddingProfileId(alias);
}

function ensureProfile(alias: EmbeddingModelAlias): ProfileRow {
  const definition = EMBEDDING_PROFILE_DEFINITIONS[alias];
  const id = profileIdFor(alias);
  getDatabase().prepare(`
    INSERT OR IGNORE INTO embedding_profiles (
      id, provider, model_alias, model, model_revision, dimension, distance_metric,
      normalized, query_instruction, document_template_version, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'cosine', 1, ?, ?, 'active', ?)
  `).run(
    id, definition.provider, alias, definition.model, definition.revision,
    definition.dimension, definition.queryInstruction, definition.documentTemplateVersion,
    new Date().toISOString(),
  );
  const row = getDatabase().prepare(`
    SELECT id, model_alias, model, model_revision, dimension
    FROM embedding_profiles WHERE id = ? AND status = 'active'
  `).get(id) as ProfileRow | undefined;
  if (!row) throw new EmbeddingIndexError("Embedding 配置不可用。", 503);
  return row;
}

function configuredBatchSize() {
  const parsed = Number(process.env.EMBEDDING_BATCH_SIZE || 8);
  return Number.isFinite(parsed) ? Math.min(32, Math.max(1, Math.floor(parsed))) : 8;
}

function vectorNorm(vector: number[]) {
  return Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
}

function vectorBlob(vector: number[]) {
  const floats = Float32Array.from(vector);
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength);
}

function decodeVector(blob: Uint8Array, dimension: number) {
  if (blob.byteLength !== dimension * Float32Array.BYTES_PER_ELEMENT) {
    throw new EmbeddingIndexError("数据库中的向量维度已损坏。", 500);
  }
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer);
}

function validateServiceProfile(
  alias: EmbeddingModelAlias,
  result: Awaited<ReturnType<typeof embedTexts>>,
) {
  const expected = EMBEDDING_PROFILE_DEFINITIONS[alias];
  if (result.model !== expected.model
    || result.revision !== expected.revision
    || result.dimension !== expected.dimension
    || !result.normalized) {
    throw new EmbeddingIndexError(
      `Embedding 服务模型不匹配：期望 ${expected.model}@${expected.revision.slice(0, 8)} / ${expected.dimension} 维。`,
      502,
    );
  }
}

export function listKnowledgeSourceEmbeddingStatus(userId: string, sourceId: string) {
  const source = sourceForUser(userId, sourceId);
  if (!source) return null;
  const rows = getDatabase().prepare(`
    SELECT ep.model_alias, ep.id AS profile_id, COUNT(sce.chunk_id) AS embedded_count,
           MAX(sce.created_at) AS updated_at
    FROM embedding_profiles ep
    LEFT JOIN source_chunk_embeddings sce
      ON sce.profile_id = ep.id AND sce.user_id = ? AND sce.source_id = ? AND sce.chunk_set_id = ?
    WHERE ep.model_alias IN ('bge-m3', 'qwen3-embedding-0.6b') AND ep.status = 'active'
    GROUP BY ep.id, ep.model_alias
  `).all(userId, source.id, source.active_chunk_set_id) as Array<{
    model_alias: EmbeddingModelAlias;
    profile_id: string;
    embedded_count: number;
    updated_at: string | null;
  }>;
  const byAlias = new Map(rows.map((row) => [row.model_alias, row]));
  const totalCount = activeChunks(userId, source).length;
  return {
    sourceId,
    chunkSetId: source.active_chunk_set_id,
    totalCount,
    profiles: EMBEDDING_MODEL_ALIASES.map((alias) => ({
      model: alias,
      profileId: byAlias.get(alias)?.profile_id || null,
      embeddedCount: Number(byAlias.get(alias)?.embedded_count || 0),
      complete: totalCount > 0 && Number(byAlias.get(alias)?.embedded_count || 0) === totalCount,
      updatedAt: byAlias.get(alias)?.updated_at || null,
    })),
  };
}

export async function vectorizeKnowledgeSource(request: {
  userId: string;
  sourceId: string;
  model?: EmbeddingModelAlias;
}): Promise<EmbeddingIndexSummary> {
  const input = { ...request, model: request.model ?? configuredEmbeddingModel() };
  const source = sourceForUser(input.userId, input.sourceId);
  if (!source) throw new EmbeddingIndexError("资料不存在、尚未就绪或已经删除。", 404);
  if (getDatabase().prepare("SELECT 1 FROM source_chunk_sets WHERE id = ? AND strategy = 'ragflow'").get(source.active_chunk_set_id)) {
    throw new EmbeddingIndexError('此资料的向量化由 RAGFlow 管理，不需要在学习助手中重复向量化。', 409);
  }
  const chunks = activeChunks(input.userId, source);
  if (chunks.length === 0) throw new EmbeddingIndexError("这份资料还没有可向量化的子片段。", 409);
  const profile = ensureProfile(input.model);
  const batchSize = configuredBatchSize();
  const pipeline = beginPipelineRun({
    userId: input.userId,
    sourceId: source.id,
    chunkSetId: source.active_chunk_set_id,
    operation: "embedding",
    profileId: profile.id,
    config: { model: input.model, batchSize, totalCount: chunks.length, template: "context-prefix-v1" },
  });
  const runId = randomUUID();
  const createdAt = new Date().toISOString();
  getDatabase().prepare(`
    INSERT INTO embedding_runs (
      id, user_id, source_id, chunk_set_id, profile_id, pipeline_run_id,
      status, total_count, started_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)
  `).run(
    runId, input.userId, source.id, source.active_chunk_set_id, profile.id,
    pipeline.id, chunks.length, createdAt, createdAt,
  );

  let currentStage = "embedding.encode";
  const totals = {
    modelLoadMs: 0,
    tokenizeMs: 0,
    encodeMs: 0,
    serviceRoundtripMs: 0,
    persistMs: 0,
    inputTokens: 0,
  };
  let device = "";
  let dtype = "";
  try {
    const existingRows = getDatabase().prepare(`
      SELECT chunk_id, content_hash FROM source_chunk_embeddings
      WHERE user_id = ? AND source_id = ? AND chunk_set_id = ? AND profile_id = ?
    `).all(input.userId, source.id, source.active_chunk_set_id, profile.id) as Array<{
      chunk_id: string;
      content_hash: string;
    }>;
    const existing = new Map(existingRows.map((row) => [row.chunk_id, row.content_hash]));
    const pending = chunks.filter((chunk) => existing.get(chunk.id) !== sha256(documentText(chunk)));
    const reusedCount = chunks.length - pending.length;
    getDatabase().prepare("UPDATE embedding_runs SET completed_count = ? WHERE id = ?")
      .run(reusedCount, runId);

    for (let offset = 0; offset < pending.length; offset += batchSize) {
      const batch = pending.slice(offset, offset + batchSize);
      const result = await embedTexts({
        model: input.model,
        inputType: "document",
        texts: batch.map(documentText),
      });
      validateServiceProfile(input.model, result);
      device = result.device;
      dtype = result.dtype;
      totals.modelLoadMs += result.timing.modelLoadMs;
      totals.tokenizeMs += result.timing.tokenizeMs;
      totals.encodeMs += result.timing.encodeMs;
      totals.serviceRoundtripMs += result.timing.serviceRoundtripMs;
      totals.inputTokens += result.inputTokens;

      currentStage = "embedding.persist";
      const persistStarted = performance.now();
      withTransaction((database) => {
        const upsert = database.prepare(`
          INSERT INTO source_chunk_embeddings (
            chunk_id, profile_id, chunk_set_id, source_id, user_id, content_hash,
            vector_blob, dimension, norm, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(chunk_id, profile_id) DO UPDATE SET
            chunk_set_id = excluded.chunk_set_id,
            source_id = excluded.source_id,
            user_id = excluded.user_id,
            content_hash = excluded.content_hash,
            vector_blob = excluded.vector_blob,
            dimension = excluded.dimension,
            norm = excluded.norm,
            created_at = excluded.created_at
        `);
        for (let index = 0; index < batch.length; index += 1) {
          const norm = vectorNorm(result.vectors[index]);
          if (Math.abs(norm - 1) > 0.01) {
            throw new EmbeddingIndexError(`模型返回了未归一化向量（norm=${norm.toFixed(4)}）。`, 502);
          }
          const chunk = batch[index];
          upsert.run(
            chunk.id, profile.id, chunk.chunk_set_id, chunk.source_id, input.userId,
            sha256(documentText(chunk)), vectorBlob(result.vectors[index]), result.dimension,
            norm, new Date().toISOString(),
          );
        }
        database.prepare("UPDATE embedding_runs SET completed_count = completed_count + ? WHERE id = ?")
          .run(batch.length, runId);
      });
      totals.persistMs += performance.now() - persistStarted;
      currentStage = "embedding.encode";
    }

    const common = {
      pipelineRunId: pipeline.id,
      provider: EMBEDDING_PROFILE_DEFINITIONS[input.model].provider,
      model: profile.model,
      modelRevision: profile.model_revision,
      device,
      batchSize,
      inputCount: pending.length,
      outputCount: pending.length,
    };
    recordPipelineStage({
      ...common,
      stage: "embedding.model_load",
      status: totals.modelLoadMs > 0 ? "completed" : "skipped",
      wallDurationMs: totals.modelLoadMs,
      computeDurationMs: totals.modelLoadMs,
      inputCount: 0,
      outputCount: 0,
      cacheState: totals.modelLoadMs > 0 ? "cold" : "warm",
      metadata: { dtype },
    });
    recordPipelineStage({
      ...common,
      stage: "embedding.tokenize",
      status: pending.length > 0 ? "completed" : "skipped",
      wallDurationMs: totals.tokenizeMs,
      computeDurationMs: totals.tokenizeMs,
      inputTokens: totals.inputTokens,
    });
    recordPipelineStage({
      ...common,
      stage: "embedding.encode",
      status: pending.length > 0 ? "completed" : "skipped",
      wallDurationMs: totals.encodeMs,
      computeDurationMs: totals.encodeMs,
      inputTokens: totals.inputTokens,
      metadata: { dtype, serviceRoundtripMs: totals.serviceRoundtripMs },
    });
    recordPipelineStage({
      ...common,
      stage: "embedding.persist",
      status: pending.length > 0 ? "completed" : "skipped",
      wallDurationMs: totals.persistMs,
      computeDurationMs: totals.persistMs,
    });
    const completedAt = new Date().toISOString();
    getDatabase().prepare(`
      UPDATE embedding_runs SET status = 'completed', completed_count = total_count,
        completed_at = ? WHERE id = ?
    `).run(completedAt, runId);
    completePipelineRun(pipeline.id, pipeline.startedMonotonicMs);
    const durationMs = performance.now() - pipeline.startedMonotonicMs;
    return {
      runId,
      pipelineRunId: pipeline.id,
      traceId: pipeline.traceId,
      profileId: profile.id,
      model: input.model,
      totalCount: chunks.length,
      embeddedCount: pending.length,
      reusedCount,
      device,
      dtype,
      durationMs,
      timing: {
        modelLoadMs: totals.modelLoadMs,
        tokenizeMs: totals.tokenizeMs,
        encodeMs: totals.encodeMs,
        serviceRoundtripMs: totals.serviceRoundtripMs,
        persistMs: totals.persistMs,
      },
    };
  } catch (error) {
    const message = errorMessage(error);
    const code = error instanceof EmbeddingServiceError ? "EMBEDDING_SERVICE_ERROR" : "EMBEDDING_RUN_ERROR";
    try {
      recordPipelineStage({
        pipelineRunId: pipeline.id,
        stage: currentStage,
        status: "failed",
        wallDurationMs: performance.now() - pipeline.startedMonotonicMs,
        provider: EMBEDDING_PROFILE_DEFINITIONS[input.model].provider,
        model: profile.model,
        modelRevision: profile.model_revision,
        device,
        batchSize,
        errorCode: code,
        errorMessage: message,
      });
    } catch {
      // Keep the original embedding failure as the user-visible error.
    }
    getDatabase().prepare(`
      UPDATE embedding_runs SET status = 'failed', failed_count = total_count - completed_count,
        completed_at = ?, error_code = ?, error_message = ? WHERE id = ?
    `).run(new Date().toISOString(), code, message.slice(0, 2_000), runId);
    failPipelineRun({
      id: pipeline.id,
      startedMonotonicMs: pipeline.startedMonotonicMs,
      errorCode: code,
      errorMessage: message,
    });
    throw error;
  }
}

export async function searchKnowledgeSourceVectors(request: {
  userId: string;
  sourceId: string;
  model?: EmbeddingModelAlias;
  query: string;
  limit?: number;
}) {
  const input = { ...request, model: request.model ?? configuredEmbeddingModel() };
  const query = input.query.trim();
  if (!query) throw new EmbeddingIndexError("请输入检索问题。", 400);
  const source = sourceForUser(input.userId, input.sourceId);
  if (!source) throw new EmbeddingIndexError("资料不存在、尚未就绪或已经删除。", 404);
  const profile = getDatabase().prepare(`
    SELECT id, model_alias, model, model_revision, dimension
    FROM embedding_profiles WHERE id = ? AND status = 'active'
  `).get(profileIdFor(input.model)) as ProfileRow | undefined;
  if (!profile) throw new EmbeddingIndexError("这份资料尚未使用该模型完成向量化。", 409);
  const candidateCount = getDatabase().prepare(`
    SELECT COUNT(*) AS count FROM source_chunk_embeddings
    WHERE user_id = ? AND source_id = ? AND chunk_set_id = ? AND profile_id = ?
  `).get(input.userId, source.id, source.active_chunk_set_id, profile.id) as { count: number };
  if (Number(candidateCount.count) === 0) {
    throw new EmbeddingIndexError("这份资料尚未使用该模型完成向量化。", 409);
  }

  const limit = Math.min(20, Math.max(1, Math.floor(input.limit || 5)));
  const pipeline = beginPipelineRun({
    userId: input.userId,
    sourceId: source.id,
    chunkSetId: source.active_chunk_set_id,
    operation: "retrieval",
    profileId: profile.id,
    config: { model: input.model, mode: "vector_exact", limit },
  });
  const retrievalRunId = randomUUID();
  const createdAt = new Date().toISOString();
  let currentStage = "retrieval.query_encode";
  try {
    const queryResult = await embedTexts({ model: input.model, inputType: "query", texts: [query] });
    validateServiceProfile(input.model, queryResult);
    recordPipelineStage({
      pipelineRunId: pipeline.id,
      stage: "retrieval.query_encode",
      wallDurationMs: queryResult.timing.serviceRoundtripMs,
      computeDurationMs: queryResult.timing.encodeMs,
      inputCount: 1,
      outputCount: 1,
      inputTokens: queryResult.inputTokens,
      cacheState: queryResult.timing.modelLoadMs > 0 ? "cold" : "warm",
      provider: EMBEDDING_PROFILE_DEFINITIONS[input.model].provider,
      model: profile.model,
      modelRevision: profile.model_revision,
      device: queryResult.device,
      batchSize: 1,
      metadata: {
        dtype: queryResult.dtype,
        modelLoadMs: queryResult.timing.modelLoadMs,
        tokenizeMs: queryResult.timing.tokenizeMs,
      },
    });

    currentStage = "retrieval.filter";
    const filterStarted = performance.now();
    const candidates = getDatabase().prepare(`
      SELECT sc.id, sc.chunk_set_id, sc.source_version_id, sc.source_id, sc.position,
             sc.parent_chunk_id, sc.heading, sc.context_prefix, sc.content,
             sc.token_estimate, sc.content_hash, sce.vector_blob, sce.dimension,
             pc.heading AS parent_heading, pc.content AS parent_content,
             pc.token_estimate AS parent_token_estimate, pc.content_hash AS parent_content_hash
      FROM source_chunk_embeddings sce
      JOIN source_chunks sc ON sc.id = sce.chunk_id
      JOIN source_parent_chunks pc ON pc.id = sc.parent_chunk_id
      WHERE sce.user_id = ? AND sce.source_id = ? AND sce.chunk_set_id = ? AND sce.profile_id = ?
      ORDER BY sc.position
    `).all(input.userId, source.id, source.active_chunk_set_id, profile.id) as CandidateRow[];
    const filterMs = performance.now() - filterStarted;
    recordPipelineStage({
      pipelineRunId: pipeline.id,
      stage: "retrieval.filter",
      wallDurationMs: filterMs,
      computeDurationMs: filterMs,
      inputCount: Number(candidateCount.count),
      outputCount: candidates.length,
      model: profile.model,
      modelRevision: profile.model_revision,
    });

    currentStage = "retrieval.vector";
    const vectorStarted = performance.now();
    const scored = await rankWithLlamaIndex(input.model, queryResult.vectors[0], candidates,
      candidate => decodeVector(candidate.vector_blob, candidate.dimension));
    const vectorMs = performance.now() - vectorStarted;
    recordPipelineStage({
      pipelineRunId: pipeline.id,
      stage: "retrieval.vector",
      wallDurationMs: vectorMs,
      computeDurationMs: vectorMs,
      inputCount: candidates.length,
      outputCount: scored.length,
      provider: "llamaindex-sqlite-snapshot",
      model: profile.model,
      modelRevision: profile.model_revision,
      metadata: { distanceMetric: "cosine", normalized: true },
    });

    currentStage = "retrieval.parent_expand";
    const expandStarted = performance.now();
    const seenParents = new Set<string>();
    const selected: Array<{ candidate: CandidateRow; score: number }> = [];
    for (const item of scored) {
      if (seenParents.has(item.candidate.parent_chunk_id)) continue;
      seenParents.add(item.candidate.parent_chunk_id);
      selected.push(item);
      if (selected.length >= limit) break;
    }
    const results: VectorSearchResult[] = selected.map((item, index) => ({
      rank: index + 1,
      score: item.score,
      chunkId: item.candidate.id,
      parentId: item.candidate.parent_chunk_id,
      heading: item.candidate.heading,
      contextPrefix: item.candidate.context_prefix,
      excerpt: item.candidate.content,
      parentHeading: item.candidate.parent_heading,
      parentContent: item.candidate.parent_content,
      tokenEstimate: item.candidate.parent_token_estimate,
    }));
    const expandMs = performance.now() - expandStarted;
    recordPipelineStage({
      pipelineRunId: pipeline.id,
      stage: "retrieval.parent_expand",
      wallDurationMs: expandMs,
      computeDurationMs: expandMs,
      inputCount: Math.min(scored.length, limit),
      outputCount: results.length,
      metadata: { deduplicatedParents: true },
    });

    currentStage = "retrieval.evidence_bundle";
    const persistStarted = performance.now();
    const totalEvidenceTokens = results.reduce((sum, result) => sum + result.tokenEstimate, 0);
    withTransaction((database) => {
      database.prepare(`
        INSERT INTO retrieval_runs (
          id, user_id, pipeline_run_id, embedding_profile_id, retrieval_mode, query,
          filters_json, top_k, max_evidence_tokens, result_count, total_evidence_tokens,
          status, latency_ms, created_at
        ) VALUES (?, ?, ?, ?, 'vector_exact', ?, ?, ?, 20000, ?, ?, 'completed', ?, ?)
      `).run(
        retrievalRunId, input.userId, pipeline.id, profile.id, query,
        JSON.stringify({ sourceId: source.id, chunkSetId: source.active_chunk_set_id }),
        limit, results.length, totalEvidenceTokens,
        Math.round(performance.now() - pipeline.startedMonotonicMs), createdAt,
      );
      const insertItem = database.prepare(`
        INSERT INTO retrieval_run_items (
          id, retrieval_run_id, source_id, source_version_id, chunk_id, rank,
          score, excerpt, snapshot_text, snapshot_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      selected.forEach((item, index) => insertItem.run(
        randomUUID(), retrievalRunId, item.candidate.source_id, item.candidate.source_version_id,
        item.candidate.id, index + 1, item.score, item.candidate.content,
        item.candidate.parent_content, item.candidate.parent_content_hash, createdAt,
      ));
    });
    const persistMs = performance.now() - persistStarted;
    recordPipelineStage({
      pipelineRunId: pipeline.id,
      stage: "retrieval.evidence_bundle",
      wallDurationMs: persistMs,
      computeDurationMs: persistMs,
      inputCount: results.length,
      outputCount: results.length,
      outputTokens: totalEvidenceTokens,
    });
    completePipelineRun(pipeline.id, pipeline.startedMonotonicMs);
    return {
      retrievalRunId,
      pipelineRunId: pipeline.id,
      traceId: pipeline.traceId,
      model: input.model,
      query,
      candidateCount: candidates.length,
      results,
      durationMs: performance.now() - pipeline.startedMonotonicMs,
    };
  } catch (error) {
    const message = errorMessage(error);
    const code = error instanceof EmbeddingServiceError ? "EMBEDDING_SERVICE_ERROR" : "VECTOR_RETRIEVAL_ERROR";
    try {
      recordPipelineStage({
        pipelineRunId: pipeline.id,
        stage: currentStage,
        status: "failed",
        wallDurationMs: performance.now() - pipeline.startedMonotonicMs,
        model: profile.model,
        modelRevision: profile.model_revision,
        errorCode: code,
        errorMessage: message,
      });
    } catch {
      // Preserve the original retrieval error.
    }
    try {
      getDatabase().prepare(`
        INSERT INTO retrieval_runs (
          id, user_id, pipeline_run_id, embedding_profile_id, retrieval_mode, query,
          filters_json, top_k, result_count, status, insufficiency_reason, latency_ms, created_at
        ) VALUES (?, ?, ?, ?, 'vector_exact', ?, ?, ?, 0, 'failed', ?, ?, ?)
      `).run(
        retrievalRunId, input.userId, pipeline.id, profile.id, query,
        JSON.stringify({ sourceId: source.id, chunkSetId: source.active_chunk_set_id }),
        limit, message.slice(0, 2_000), Math.round(performance.now() - pipeline.startedMonotonicMs), createdAt,
      );
    } catch {
      // A database failure may also prevent the audit row from being written.
    }
    failPipelineRun({
      id: pipeline.id,
      startedMonotonicMs: pipeline.startedMonotonicMs,
      errorCode: code,
      errorMessage: message,
    });
    throw error;
  }
}
