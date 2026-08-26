export const DATABASE_SCHEMA_VERSION = 1;

export const DATABASE_SCHEMA = `
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    action_streak_days INTEGER NOT NULL DEFAULT 0 CHECK (action_streak_days >= 0),
    level INTEGER NOT NULL DEFAULT 1 CHECK (level >= 1),
    role TEXT NOT NULL DEFAULT '探索者',
    focus_score INTEGER NOT NULL DEFAULT 0 CHECK (focus_score BETWEEN 0 AND 100),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

  CREATE TABLE IF NOT EXISTS goals (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    progress_percent INTEGER NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
    horizon TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'review', 'completed', 'archived')),
    progress_source TEXT NOT NULL DEFAULT 'user' CHECK (progress_source IN ('user', 'agent', 'system')),
    progress_updated_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_goals_user_status ON goals(user_id, status);

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    goal_id TEXT REFERENCES goals(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    subtitle TEXT NOT NULL DEFAULT '',
    time_label TEXT NOT NULL DEFAULT '',
    duration_minutes INTEGER NOT NULL DEFAULT 0 CHECK (duration_minutes >= 0),
    xp_reward INTEGER NOT NULL DEFAULT 0 CHECK (xp_reward >= 0),
    coin_reward INTEGER NOT NULL DEFAULT 0 CHECK (coin_reward >= 0),
    status TEXT NOT NULL DEFAULT 'upcoming' CHECK (status IN ('current', 'upcoming', 'done', 'skipped')),
    kind TEXT NOT NULL DEFAULT 'focus' CHECK (kind IN ('focus', 'learn', 'exercise', 'life', 'rest')),
    position INTEGER NOT NULL DEFAULT 0,
    completed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_tasks_user_status ON tasks(user_id, status, position);

  CREATE TABLE IF NOT EXISTS activity_logs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    raw_content TEXT NOT NULL,
    topic TEXT NOT NULL DEFAULT '',
    kind TEXT CHECK (kind IS NULL OR kind IN ('focus', 'learn', 'exercise', 'life', 'rest')),
    minutes INTEGER CHECK (minutes IS NULL OR minutes >= 0),
    output TEXT,
    intent TEXT NOT NULL DEFAULT 'quick_log' CHECK (intent IN ('quick_log', 'plan_today', 'review')),
    xp_reward INTEGER NOT NULL DEFAULT 0 CHECK (xp_reward >= 0),
    coin_reward INTEGER NOT NULL DEFAULT 0 CHECK (coin_reward >= 0),
    agent_mode TEXT NOT NULL DEFAULT 'demo' CHECK (agent_mode IN ('llm', 'demo')),
    quiz_id TEXT,
    quiz_score INTEGER CHECK (quiz_score IS NULL OR quiz_score BETWEEN 0 AND 100),
    quiz_rewarded INTEGER NOT NULL DEFAULT 0 CHECK (quiz_rewarded IN (0, 1)),
    occurred_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_activity_logs_user_time ON activity_logs(user_id, occurred_at DESC);

  CREATE TABLE IF NOT EXISTS ledger_entries (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    currency TEXT NOT NULL CHECK (currency IN ('XP', 'COIN')),
    amount INTEGER NOT NULL,
    reason TEXT NOT NULL,
    source_type TEXT NOT NULL,
    source_id TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_ledger_user_time ON ledger_entries(user_id, created_at DESC);
`;
