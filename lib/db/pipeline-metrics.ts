import { randomUUID } from "node:crypto";
import { getDatabase } from "./index.ts";

export type PipelineOperation = "ingestion" | "index" | "embedding" | "retrieval";

export function beginPipelineRun(input: {
  userId: string;
  sourceId?: string | null;
  chunkSetId?: string | null;
  operation: PipelineOperation;
  profileId?: string | null;
  config?: Record<string, unknown>;
}) {
  const id = randomUUID();
  const traceId = randomUUID();
  const startedAt = new Date().toISOString();
  getDatabase().prepare(`
    INSERT INTO pipeline_runs (
      id, trace_id, user_id, source_id, chunk_set_id, operation, profile_id,
      status, started_at, config_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)
  `).run(
    id, traceId, input.userId, input.sourceId || null, input.chunkSetId || null,
    input.operation, input.profileId || null, startedAt, JSON.stringify(input.config || {}),
  );
  return { id, traceId, startedAt, startedMonotonicMs: performance.now() };
}

export function recordPipelineStage(input: {
  pipelineRunId: string;
  stage: string;
  status?: "completed" | "failed" | "skipped";
  wallDurationMs?: number;
  computeDurationMs?: number;
  queueDurationMs?: number;
  inputCount?: number;
  outputCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheState?: string;
  provider?: string;
  model?: string;
  modelRevision?: string;
  device?: string;
  batchSize?: number | null;
  metadata?: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
  attempt?: number;
}) {
  const duration = Math.max(0, input.wallDurationMs || 0);
  const completedAt = new Date();
  const startedAt = new Date(completedAt.getTime() - duration);
  getDatabase().prepare(`
    INSERT INTO pipeline_stage_metrics (
      id, pipeline_run_id, stage, attempt, status, started_at, completed_at,
      wall_duration_ms, compute_duration_ms, queue_duration_ms, input_count,
      output_count, input_tokens, output_tokens, cache_state, provider, model,
      model_revision, device, batch_size, metadata_json, error_code, error_message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(), input.pipelineRunId, input.stage, input.attempt || 1,
    input.status || "completed", startedAt.toISOString(), completedAt.toISOString(), duration,
    Math.max(0, input.computeDurationMs || 0), Math.max(0, input.queueDurationMs || 0),
    Math.max(0, input.inputCount || 0), Math.max(0, input.outputCount || 0),
    Math.max(0, input.inputTokens || 0), Math.max(0, input.outputTokens || 0),
    input.cacheState || "", input.provider || "", input.model || "",
    input.modelRevision || "", input.device || "", input.batchSize || null,
    JSON.stringify(input.metadata || {}), input.errorCode || "", input.errorMessage || "",
  );
}

export function completePipelineRun(id: string, startedMonotonicMs: number) {
  getDatabase().prepare(`
    UPDATE pipeline_runs
    SET status = 'completed', completed_at = ?, total_duration_ms = ?
    WHERE id = ?
  `).run(new Date().toISOString(), Math.max(0, performance.now() - startedMonotonicMs), id);
}

export function failPipelineRun(input: {
  id: string;
  startedMonotonicMs: number;
  errorCode: string;
  errorMessage: string;
}) {
  getDatabase().prepare(`
    UPDATE pipeline_runs
    SET status = 'failed', completed_at = ?, total_duration_ms = ?,
        error_code = ?, error_message = ?
    WHERE id = ?
  `).run(
    new Date().toISOString(), Math.max(0, performance.now() - input.startedMonotonicMs),
    input.errorCode, input.errorMessage.slice(0, 2_000), input.id,
  );
}
