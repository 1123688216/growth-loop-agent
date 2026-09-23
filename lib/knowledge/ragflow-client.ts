/** Server-only retrieval adapter. Credentials and dataset scope never come from the model. */
export class RagflowServiceError extends Error {
  constructor(message: string) { super(message); this.name = 'RagflowServiceError'; }
}
export function ragflowEndpoint() {
  const url = new URL(process.env.RAGFLOW_BASE_URL || 'http://127.0.0.1:8088');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('RAGFlow 服务地址不合法。');
  }
  return url.href.replace(/\/$/, '');
}

export async function ragflowRequest<T>(path: string, body?: unknown): Promise<T> {
  const key = process.env.RAGFLOW_API_KEY?.trim();
  if (!key) throw new RagflowServiceError('尚未配置 RAGFLOW_API_KEY。');
  const timeout = Number(process.env.RAGFLOW_TIMEOUT_MS || 60000);
  let response: Response;
  try {
    response = await fetch(`${ragflowEndpoint()}/api/v1/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(Number.isFinite(timeout) ? Math.min(180000, Math.max(1000, timeout)) : 60000),
      redirect: 'error', cache: 'no-store',
    });
  } catch (error) {
    const failure = error as { name?: string; cause?: { code?: string } };
    const message = failure.cause?.code === 'ECONNREFUSED'
      ? 'RAGFlow 服务未启动或端口不可达，请先启动 Docker Desktop 和 RAGFlow 容器，再重试当前课程；不是资料不足。'
      : failure.name === 'TimeoutError' || failure.name === 'AbortError'
        ? 'RAGFlow 检索请求超时，请检查容器和 Embedding 服务后重试；不是资料不足。'
        : 'RAGFlow 连接失败，请检查 Docker 服务与 RAGFLOW_BASE_URL 配置；不是资料不足。';
    throw new RagflowServiceError(message);
  }
  if (!response.ok) throw new RagflowServiceError(`RAGFlow HTTP ${response.status}，请检查服务与 API Key。`);
  const result = await response.json() as { code?: number; data?: T };
  // Never log upstream messages: some providers include credentials in errors.
  if (result.code !== 0 || result.data === undefined || result.data === null) {
    throw new RagflowServiceError(`RAGFlow 接口未成功（code=${Number(result.code)}）。`);
  }
  return result.data;
}

export type RagflowChunk = {
  id: string; document_id: string; dataset_id: string; content: string;
  similarity?: number; available?: boolean; positions?: number[][];
};

async function retrieveRagflowQuery(input: {
  datasetId: string; documentIds: string[]; query: string; topK: number;
}) {
  // Empty document_ids means ALL documents in RAGFlow; fail closed instead.
  if (!input.documentIds.length) return [];
  const result = await ragflowRequest<{ chunks: RagflowChunk[] }>('retrieval', {
    question: input.query, dataset_ids: [input.datasetId], document_ids: input.documentIds,
    page: 1, page_size: input.topK, similarity_threshold: 0.2,
    vector_similarity_weight: 0.3, keyword: false, highlight: false,
  });
  if (!Array.isArray(result.chunks)) throw new Error('RAGFlow 检索响应格式不正确。');
  const allowed = new Set(input.documentIds);
  for (const chunk of result.chunks) {
    if (chunk.dataset_id !== input.datasetId || !allowed.has(chunk.document_id)
      || typeof chunk.id !== 'string' || typeof chunk.content !== 'string'
      || !Number.isFinite(chunk.similarity)) throw new Error('RAGFlow 返回了越界或无效片段，已拒绝使用。');
  }
  return result.chunks.filter(chunk => chunk.available !== false && chunk.content.trim());
}

/** One logical retrieval may contain several concrete questions. Keep each
 * question visible to the engine instead of letting one repeated term dominate. */
export async function retrieveRagflow(input: {
  datasetId: string; documentIds: string[]; query: string; topK: number;
  targetTopics?: string[];
}) {
  if (!input.documentIds.length) return [];
  const topics = [...new Set((input.targetTopics || []).filter(t => typeof t === 'string').map(t => t.trim().slice(0,160)).filter(Boolean))].slice(0,12);
  const questions = input.query.split(/[？?]\s*/u).map(q => q.trim()).filter(Boolean);
  if (questions.length < 2 && topics.length < 2) return retrieveRagflowQuery(input);
  // Preserve the entire remainder in the last slot, at most three engine requests.
  // First topic normally names the overall subject; the original query already
  // carries it. Focus the remaining two requests on the narrower requirements.
  const details = topics.slice(1);
  const width = Math.max(1, Math.floor(details.length / 2));
  const queries = topics.length >= 2
    ? [input.query, details.slice(0,width).join(' '), details.slice(width).join(' ')].filter(Boolean)
    : questions.length <= 3 ? questions : [...questions.slice(0,2), questions.slice(2).join('；')];
  const merged = new Map<string, RagflowChunk>();
  const lists: RagflowChunk[][] = [];
  for (const query of queries) {
    const chunks = await retrieveRagflowQuery({ ...input, query });
    lists.push(chunks);
    chunks.forEach(chunk => {
      const key = `${chunk.dataset_id}:${chunk.document_id}:${chunk.id}`;
      const existing = merged.get(key);
      if (existing && existing.content !== chunk.content) throw new Error('RAGFlow 文档在检索期间发生变化，请重试。');
      merged.set(key, chunk);
    });
  }
  // Topic-balanced ordering: shared overview snippets must not displace all
  // evidence for a less frequent topic before the token budget is applied.
  const selected = new Map<string, RagflowChunk>();
  for (let rank=0; rank<Math.max(...lists.map(list=>list.length)); rank++) {
    for (const list of lists) {
      const chunk = list[rank];
      if (chunk) selected.set(`${chunk.dataset_id}:${chunk.document_id}:${chunk.id}`,chunk);
      if (selected.size >= input.topK) return [...selected.values()];
    }
  }
  return [...selected.values()];
}
