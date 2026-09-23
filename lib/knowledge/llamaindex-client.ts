import type { EmbeddingModelAlias } from './embedding-profiles.ts';

export function llamaIndexUrl() {
  return (process.env.RAG_INGESTION_URL?.trim() || 'http://127.0.0.1:8010').replace(/\/$/, '');
}

/** SQLite remains the source of truth; send only pre-authorized vector batches. */
export async function rankWithLlamaIndex<T extends { id: string }>(
  model: EmbeddingModelAlias,
  queryVector: number[],
  candidates: T[],
  vectorOf: (candidate: T) => Float32Array,
): Promise<Array<{ candidate: T; score: number }>> {
  const scored: Array<{ candidate: T; score: number }> = [];
  for (let offset = 0; offset < candidates.length; offset += 128) {
    const batch = candidates.slice(offset, offset + 128);
    const response = await fetch(`${llamaIndexUrl()}/v1/retrieve/vectors`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, query_vector: queryVector,
        candidates: batch.map(candidate => ({ id: candidate.id, vector: Array.from(vectorOf(candidate)) })) }),
      cache: 'no-store', signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`LlamaIndex 检索服务失败（HTTP ${response.status}），请确认已重启 RAG 服务。`);
    const payload = await response.json() as { engine?: unknown; items?: Array<{ id: string; score: number }> };
    if (payload?.engine !== 'llamaindex' || !Array.isArray(payload.items) || payload.items.length !== batch.length) {
      throw new Error('LlamaIndex 检索结果数量或格式错误。');
    }
    const allowed = new Map(batch.map(candidate => [candidate.id, candidate]));
    for (const item of payload.items) {
      if (!item || !allowed.has(item.id) || typeof item.score !== 'number' || !Number.isFinite(item.score)) {
        throw new Error('LlamaIndex 返回了越界、重复或无效的片段结果。');
      }
      scored.push({ candidate: allowed.get(item.id)!, score: item.score });
      allowed.delete(item.id);
    }
  }
  return scored.sort((a, b) => b.score - a.score || a.candidate.id.localeCompare(b.candidate.id));
}
