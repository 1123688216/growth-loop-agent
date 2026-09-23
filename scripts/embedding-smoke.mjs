import assert from "node:assert/strict";
import { configuredEmbeddingModel } from '../lib/knowledge/embedding-config.ts';

import { getDatabase } from "../lib/db/index.ts";
import {
  listKnowledgeSourceEmbeddingStatus,
  searchKnowledgeSourceVectors,
  vectorizeKnowledgeSource,
} from "../lib/db/embeddings.ts";

function argument(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

const model = argument("model", configuredEmbeddingModel());
assert(["bge-m3", "qwen3-embedding-0.6b"].includes(model), "unsupported --model");
const requestedSourceId = argument("source");
const source = requestedSourceId
  ? getDatabase().prepare(`
      SELECT id, user_id, title FROM knowledge_sources
      WHERE id = ? AND status = 'ready' AND deleted_at IS NULL
    `).get(requestedSourceId)
  : getDatabase().prepare(`
      SELECT id, user_id, title FROM knowledge_sources
      WHERE status = 'ready' AND deleted_at IS NULL
      ORDER BY updated_at DESC LIMIT 1
    `).get();
assert(source, "no ready knowledge source found");

const before = listKnowledgeSourceEmbeddingStatus(source.user_id, source.id);
console.log(JSON.stringify({ step: "before", source, status: before }));
const run = await vectorizeKnowledgeSource({
  userId: source.user_id,
  sourceId: source.id,
  model,
});
console.log(JSON.stringify({ step: "embedding", run }));
const query = argument("query", "这份资料主要说明了什么？");
const retrieval = await searchKnowledgeSourceVectors({
  userId: source.user_id,
  sourceId: source.id,
  model,
  query,
  limit: 3,
});
console.log(JSON.stringify({
  step: "retrieval",
  retrievalRunId: retrieval.retrievalRunId,
  pipelineRunId: retrieval.pipelineRunId,
  durationMs: retrieval.durationMs,
  results: retrieval.results.map((result) => ({
    rank: result.rank,
    score: result.score,
    heading: result.heading,
    excerpt: result.excerpt.slice(0, 160),
  })),
}));
