export const EMBEDDING_SCHEMA = `
  CREATE TABLE IF NOT EXISTS embedding_profiles (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    model_alias TEXT NOT NULL,
    model TEXT NOT NULL,
    model_revision TEXT NOT NULL,
    dimension INTEGER NOT NULL CHECK (dimension > 0),
    distance_metric TEXT NOT NULL DEFAULT 'cosine' CHECK (distance_metric = 'cosine'),
    normalized INTEGER NOT NULL DEFAULT 1 CHECK (normalized IN (0, 1)),
    query_instruction TEXT NOT NULL DEFAULT '',
    document_template_version TEXT NOT NULL DEFAULT 'context-prefix-v1',
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    created_at TEXT NOT NULL,
    UNIQUE(provider, model, model_revision, dimension, query_instruction, document_template_version)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_embedding_profiles_alias
    ON embedding_profiles(model_alias, status, created_at DESC);

  CREATE TABLE IF NOT EXISTS pipeline_runs (
    id TEXT PRIMARY KEY,
    trace_id TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source_id TEXT REFERENCES knowledge_sources(id) ON DELETE CASCADE,
    chunk_set_id TEXT REFERENCES source_chunk_sets(id) ON DELETE SET NULL,
    operation TEXT NOT NULL CHECK (operation IN ('ingestion', 'index', 'embedding', 'retrieval')),
    profile_id TEXT REFERENCES embedding_profiles(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'running'
      CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
    started_at TEXT NOT NULL,
    completed_at TEXT,
    total_duration_ms REAL CHECK (total_duration_ms IS NULL OR total_duration_ms >= 0),
    config_json TEXT NOT NULL DEFAULT '{}',
    error_code TEXT NOT NULL DEFAULT '',
    error_message TEXT NOT NULL DEFAULT ''
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_pipeline_runs_user_time
    ON pipeline_runs(user_id, started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_pipeline_runs_source_time
    ON pipeline_runs(source_id, started_at DESC);

  CREATE TABLE IF NOT EXISTS pipeline_stage_metrics (
    id TEXT PRIMARY KEY,
    pipeline_run_id TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
    parent_stage_id TEXT REFERENCES pipeline_stage_metrics(id) ON DELETE SET NULL,
    stage TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'skipped')),
    started_at TEXT NOT NULL,
    completed_at TEXT,
    wall_duration_ms REAL CHECK (wall_duration_ms IS NULL OR wall_duration_ms >= 0),
    compute_duration_ms REAL CHECK (compute_duration_ms IS NULL OR compute_duration_ms >= 0),
    queue_duration_ms REAL CHECK (queue_duration_ms IS NULL OR queue_duration_ms >= 0),
    input_count INTEGER NOT NULL DEFAULT 0 CHECK (input_count >= 0),
    output_count INTEGER NOT NULL DEFAULT 0 CHECK (output_count >= 0),
    input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
    output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
    cache_state TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    model_revision TEXT NOT NULL DEFAULT '',
    device TEXT NOT NULL DEFAULT '',
    batch_size INTEGER CHECK (batch_size IS NULL OR batch_size > 0),
    metadata_json TEXT NOT NULL DEFAULT '{}',
    error_code TEXT NOT NULL DEFAULT '',
    error_message TEXT NOT NULL DEFAULT '',
    UNIQUE(pipeline_run_id, stage, attempt)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_pipeline_stage_run
    ON pipeline_stage_metrics(pipeline_run_id, started_at, stage);
  CREATE INDEX IF NOT EXISTS idx_pipeline_stage_compare
    ON pipeline_stage_metrics(stage, model, model_revision, device, started_at DESC);

  CREATE TABLE IF NOT EXISTS embedding_runs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source_id TEXT NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
    chunk_set_id TEXT NOT NULL REFERENCES source_chunk_sets(id) ON DELETE CASCADE,
    profile_id TEXT NOT NULL REFERENCES embedding_profiles(id) ON DELETE RESTRICT,
    pipeline_run_id TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'queued'
      CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
    total_count INTEGER NOT NULL DEFAULT 0 CHECK (total_count >= 0),
    completed_count INTEGER NOT NULL DEFAULT 0 CHECK (completed_count >= 0),
    failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
    started_at TEXT,
    completed_at TEXT,
    error_code TEXT NOT NULL DEFAULT '',
    error_message TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_embedding_runs_source_profile
    ON embedding_runs(user_id, source_id, profile_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS source_chunk_embeddings (
    chunk_id TEXT NOT NULL REFERENCES source_chunks(id) ON DELETE CASCADE,
    profile_id TEXT NOT NULL REFERENCES embedding_profiles(id) ON DELETE RESTRICT,
    chunk_set_id TEXT NOT NULL REFERENCES source_chunk_sets(id) ON DELETE CASCADE,
    source_id TEXT NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content_hash TEXT NOT NULL,
    vector_blob BLOB NOT NULL,
    dimension INTEGER NOT NULL CHECK (dimension > 0),
    norm REAL NOT NULL CHECK (norm > 0),
    created_at TEXT NOT NULL,
    PRIMARY KEY (chunk_id, profile_id)
  ) WITHOUT ROWID, STRICT;

  CREATE INDEX IF NOT EXISTS idx_chunk_embeddings_candidates
    ON source_chunk_embeddings(user_id, source_id, chunk_set_id, profile_id);
`;

