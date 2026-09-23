export const EMBEDDING_MODEL_ALIASES = ["bge-m3", "qwen3-embedding-0.6b"] as const;

export type EmbeddingModelAlias = (typeof EMBEDDING_MODEL_ALIASES)[number];

export type EmbeddingProfileDefinition = {
  alias: EmbeddingModelAlias;
  provider: "local-transformers";
  model: string;
  revision: string;
  dimension: 1024;
  queryInstruction: string;
  documentTemplateVersion: "context-prefix-v1";
};

export const EMBEDDING_PROFILE_DEFINITIONS: Record<EmbeddingModelAlias, EmbeddingProfileDefinition> = {
  "bge-m3": {
    alias: "bge-m3",
    provider: "local-transformers",
    model: "BAAI/bge-m3",
    revision: "5617a9f61b028005a4858fdac845db406aefb181",
    dimension: 1024,
    queryInstruction: "",
    documentTemplateVersion: "context-prefix-v1",
  },
  "qwen3-embedding-0.6b": {
    alias: "qwen3-embedding-0.6b",
    provider: "local-transformers",
    model: "Qwen/Qwen3-Embedding-0.6B",
    revision: "97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3",
    dimension: 1024,
    queryInstruction: "Instruct: Given a learning question, retrieve passages that contain evidence needed to answer it.\nQuery: ",
    documentTemplateVersion: "context-prefix-v1",
  },
};

export function isEmbeddingModelAlias(value: unknown): value is EmbeddingModelAlias {
  return typeof value === "string" && EMBEDDING_MODEL_ALIASES.includes(value as EmbeddingModelAlias);
}

export function embeddingProfileId(alias: EmbeddingModelAlias) {
  const definition = EMBEDDING_PROFILE_DEFINITIONS[alias];
  return `local:${alias}:${definition.revision.slice(0, 12)}:${definition.documentTemplateVersion}`;
}
