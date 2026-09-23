import { isEmbeddingModelAlias, type EmbeddingModelAlias } from './embedding-profiles.ts';

/** Shared server-side default for document indexing and query embedding. */
export function configuredEmbeddingModel(): EmbeddingModelAlias {
  const value = process.env.EMBEDDING_MODEL?.trim() || 'qwen3-embedding-0.6b';
  if (!isEmbeddingModelAlias(value)) throw new Error('EMBEDDING_MODEL 仅支持 bge-m3 或 qwen3-embedding-0.6b，请检查服务端配置。');
  return value;
}
