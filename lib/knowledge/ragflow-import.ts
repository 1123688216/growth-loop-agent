import { createHash } from 'node:crypto';
import { getDatabase } from '../db/index.ts';
import { createKnowledgeSource } from '../db/knowledge-sources.ts';
import { ragflowEndpoint, ragflowRequest, type RagflowChunk } from './ragflow-client.ts';

/** Administrator-local operation, not an Agent tool or public route. */
export async function importRagflowDocument(userId: string, datasetId: string, documentId: string) {
  const db = getDatabase();
  if (!db.prepare('SELECT id FROM users WHERE id = ?').get(userId)) throw new Error('账号不存在。');
  const endpoint = ragflowEndpoint();
  const existing = db.prepare(`SELECT ks.id FROM knowledge_sources ks
    JOIN source_chunk_sets cs ON cs.id = ks.active_chunk_set_id
    WHERE ks.user_id = ? AND ks.deleted_at IS NULL AND ks.status != 'deleted'
      AND json_extract(cs.config_json, '$.ragflow.endpoint') = ?
      AND json_extract(cs.config_json, '$.ragflow.datasetId') = ?
      AND json_extract(cs.config_json, '$.ragflow.documentId') = ?`).get(userId, endpoint, datasetId, documentId) as { id: string } | undefined;
  if (existing) return { sourceId: existing.id, reused: true };
  const path = `datasets/${encodeURIComponent(datasetId)}/documents`;
  const docs = await ragflowRequest<{ docs: Array<{ id: string; name: string; run: string }> }>(`${path}?id=${encodeURIComponent(documentId)}`);
  const doc = docs.docs?.find(item => item.id === documentId);
  if (!doc || doc.run !== 'DONE') throw new Error('RAGFlow 文档不存在或尚未解析完成。');
  const chunks: RagflowChunk[] = [];
  const seen = new Set<string>();
  let expectedTotal: number | undefined;
  for (let page = 1; ; page++) {
    const result = await ragflowRequest<{ total: number; chunks: RagflowChunk[] }>(`${path}/${encodeURIComponent(documentId)}/chunks?page=${page}&page_size=100`);
    if (!Number.isInteger(result.total) || result.total < 0 || !Array.isArray(result.chunks)) throw new Error('RAGFlow 分页响应无效。');
    expectedTotal ??= result.total;
    if (expectedTotal !== result.total) throw new Error('导入期间文档发生变化，请完成解析后重试。');
    for (const chunk of result.chunks) {
      if (chunk.dataset_id !== datasetId || chunk.document_id !== documentId || typeof chunk.id !== 'string'
        || typeof chunk.content !== 'string' || seen.has(chunk.id)) throw new Error('RAGFlow 片段范围或分页异常。');
      seen.add(chunk.id);
      if (chunk.available !== false && chunk.content.trim()) chunks.push(chunk);
    }
    if (seen.size >= expectedTotal) break;
    if (!result.chunks.length) throw new Error('RAGFlow 分页提前结束，未保存不完整资料。');
  }
  if (!chunks.length) throw new Error('文档没有启用的文本片段。');
  let offset = 0;
  const parents = chunks.map((chunk, position) => {
    const start = offset; offset += chunk.content.length + 2;
    const pages = (chunk.positions || []).map(p => p[0]).filter(p => Number.isInteger(p) && p >= 1);
    return { position, heading: '', sectionPath: [] as string[], content: chunk.content,
      pageStart: pages.length ? Math.min(...pages) : null, pageEnd: pages.length ? Math.max(...pages) : null,
      charStart: start, charEnd: start + chunk.content.length, tokenEstimate: Math.max(1, Math.ceil(chunk.content.length / 2)) };
  });
  const text = chunks.map(c => c.content).join('\n\n');
  const remote = { endpoint, datasetId, documentId };
  // Mirror existing chunks for UI/citation FK compatibility, never rechunk or re-embed.
  // Parent == child is an adapter record, NOT a claim that RAGFlow produced parent-child chunks.
  const source = createKnowledgeSource({ userId, title: doc.name, description: 'RAGFlow 已解析资料（本地片段快照；检索由 RAGFlow 执行）',
    kind: 'text', originalFilename: doc.name, mimeType: 'text/plain',
    buffer: Buffer.from(JSON.stringify({ remote, hash: createHash('sha256').update(text).digest('hex') })),
    extracted: { status: 'ready', text, normalizedMarkdown: text, pages: [], nodes: [],
      parserName: 'ragflow', parserVersion: 'ragflow-snapshot-v1', outputFormat: 'ragflow-chunks', warnings: [], errorMessage: '' },
    chunkSet: { strategy: 'ragflow', strategyVersion: 'ragflow-snapshot-v1', config: { ragflow: remote }, warnings: [],
      parents, chunks: parents.map((parent, i) => ({ ...parent, parentPosition: i, contextPrefix: '',
        nodeStartPosition: null, nodeEndPosition: null, boundaryReason: { method: 'ragflow', ragflowChunkId: chunks[i].id } })) },
  });
  return { sourceId: source.id, reused: false, chunks: chunks.length };
}
