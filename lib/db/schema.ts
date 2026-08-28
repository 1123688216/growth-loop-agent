export const DATABASE_SCHEMA_VERSION = 5;

/**
 * 给已存在的表加列：`CREATE TABLE IF NOT EXISTS` 对已建好的表会整条跳过，
 * 新列不会出现。新库由上面的建表语句直接带上该列，老库靠这里补齐。
 * SQLite 的 ADD COLUMN 只接受可空列或常量默认值，改列/删列需另想办法。
 */
export const COLUMN_ADDITIONS: Array<{ table: string; column: string; ddl: string }> = [
  { table: "goals", column: "target_date", ddl: "ALTER TABLE goals ADD COLUMN target_date TEXT" },
  { table: "course_lessons", column: "generation_mode", ddl: "ALTER TABLE course_lessons ADD COLUMN generation_mode TEXT NOT NULL DEFAULT 'llm'" },
  { table: "course_lessons", column: "generation_status", ddl: "ALTER TABLE course_lessons ADD COLUMN generation_status TEXT NOT NULL DEFAULT 'ready'" },
  { table: "course_lessons", column: "difficulty", ddl: "ALTER TABLE course_lessons ADD COLUMN difficulty INTEGER NOT NULL DEFAULT 3" },
  { table: "diagnostic_assessments", column: "min_questions", ddl: "ALTER TABLE diagnostic_assessments ADD COLUMN min_questions INTEGER NOT NULL DEFAULT 5" },
  { table: "diagnostic_assessments", column: "max_questions", ddl: "ALTER TABLE diagnostic_assessments ADD COLUMN max_questions INTEGER NOT NULL DEFAULT 8" },
  { table: "diagnostic_assessments", column: "answered_count", ddl: "ALTER TABLE diagnostic_assessments ADD COLUMN answered_count INTEGER NOT NULL DEFAULT 0" },
  { table: "diagnostic_assessments", column: "adaptive_state_json", ddl: "ALTER TABLE diagnostic_assessments ADD COLUMN adaptive_state_json TEXT NOT NULL DEFAULT '{}'" },
];

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
    target_date TEXT,
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

  CREATE TABLE IF NOT EXISTS goal_learning_profiles (
    goal_id TEXT PRIMARY KEY REFERENCES goals(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    self_level TEXT NOT NULL CHECK (self_level IN ('beginner', 'familiar', 'intermediate')),
    weekly_hours INTEGER NOT NULL DEFAULT 4 CHECK (weekly_hours BETWEEN 1 AND 40),
    background TEXT NOT NULL DEFAULT '',
    diagnostic_required INTEGER NOT NULL DEFAULT 0 CHECK (diagnostic_required IN (0, 1)),
    diagnostic_status TEXT NOT NULL DEFAULT 'skipped' CHECK (diagnostic_status IN ('skipped', 'pending', 'in_progress', 'completed', 'failed')),
    diagnostic_score INTEGER CHECK (diagnostic_score IS NULL OR diagnostic_score BETWEEN 0 AND 100),
    baseline_summary TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_goal_learning_profiles_user ON goal_learning_profiles(user_id, self_level);

  CREATE TABLE IF NOT EXISTS goal_skills (
    id TEXT PRIMARY KEY,
    goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    target_level INTEGER NOT NULL DEFAULT 3 CHECK (target_level BETWEEN 1 AND 5),
    weight REAL NOT NULL DEFAULT 1.0 CHECK (weight > 0 AND weight <= 10),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    source TEXT NOT NULL DEFAULT 'agent' CHECK (source IN ('agent', 'user', 'system')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(goal_id, name)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_goal_skills_goal ON goal_skills(goal_id, status);
  CREATE INDEX IF NOT EXISTS idx_goal_skills_user ON goal_skills(user_id, status);

  CREATE TABLE IF NOT EXISTS skill_mastery (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    skill_id TEXT NOT NULL REFERENCES goal_skills(id) ON DELETE CASCADE,
    mastery_score INTEGER NOT NULL DEFAULT 0 CHECK (mastery_score BETWEEN 0 AND 100),
    confidence REAL NOT NULL DEFAULT 0 CHECK (confidence BETWEEN 0 AND 1),
    evidence_count INTEGER NOT NULL DEFAULT 0 CHECK (evidence_count >= 0),
    last_assessed_at TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, skill_id)
  ) WITHOUT ROWID, STRICT;

  CREATE INDEX IF NOT EXISTS idx_skill_mastery_user_score ON skill_mastery(user_id, mastery_score);

  CREATE TABLE IF NOT EXISTS learning_programs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    cadence TEXT NOT NULL DEFAULT '',
    outcomes_json TEXT NOT NULL DEFAULT '[]',
    instructor_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'completed', 'archived')),
    generation_mode TEXT NOT NULL DEFAULT 'demo' CHECK (generation_mode IN ('llm', 'demo', 'manual')),
    provider TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(goal_id, version)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_learning_programs_user_status ON learning_programs(user_id, status);
  CREATE INDEX IF NOT EXISTS idx_learning_programs_goal ON learning_programs(goal_id, version DESC);

  CREATE TABLE IF NOT EXISTS course_modules (
    id TEXT PRIMARY KEY,
    program_id TEXT NOT NULL REFERENCES learning_programs(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    objective TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(program_id, position)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_course_modules_program ON course_modules(program_id, position);

  CREATE TABLE IF NOT EXISTS course_lessons (
    id TEXT PRIMARY KEY,
    program_id TEXT NOT NULL REFERENCES learning_programs(id) ON DELETE CASCADE,
    module_id TEXT REFERENCES course_modules(id) ON DELETE SET NULL,
    primary_skill_id TEXT REFERENCES goal_skills(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    phase TEXT NOT NULL DEFAULT '',
    objective TEXT NOT NULL DEFAULT '',
    opening TEXT NOT NULL DEFAULT '',
    explanation TEXT NOT NULL DEFAULT '',
    example TEXT NOT NULL DEFAULT '',
    practice TEXT NOT NULL DEFAULT '',
    deliverable TEXT NOT NULL DEFAULT '',
    concepts_json TEXT NOT NULL DEFAULT '[]',
    questions_json TEXT NOT NULL DEFAULT '[]',
    duration_minutes INTEGER NOT NULL DEFAULT 0 CHECK (duration_minutes >= 0),
    required_score INTEGER NOT NULL DEFAULT 60 CHECK (required_score BETWEEN 0 AND 100),
    position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
    status TEXT NOT NULL DEFAULT 'locked' CHECK (status IN ('locked', 'available', 'in_progress', 'passed', 'archived')),
    generation_mode TEXT NOT NULL DEFAULT 'llm' CHECK (generation_mode IN ('llm', 'demo', 'manual')),
    generation_status TEXT NOT NULL DEFAULT 'ready' CHECK (generation_status IN ('planned', 'generating', 'ready', 'failed')),
    difficulty INTEGER NOT NULL DEFAULT 3 CHECK (difficulty BETWEEN 1 AND 5),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(program_id, position)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_course_lessons_program ON course_lessons(program_id, position);
  CREATE INDEX IF NOT EXISTS idx_course_lessons_skill ON course_lessons(primary_skill_id, status);

  CREATE TABLE IF NOT EXISTS task_lesson_links (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    lesson_id TEXT NOT NULL REFERENCES course_lessons(id) ON DELETE CASCADE,
    required_score INTEGER NOT NULL DEFAULT 60 CHECK (required_score BETWEEN 0 AND 100),
    completion_rule TEXT NOT NULL DEFAULT 'passing_score' CHECK (completion_rule IN ('passing_score', 'passing_score_and_deliverable', 'manual')),
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_task_lesson_links_lesson ON task_lesson_links(lesson_id);

  CREATE TABLE IF NOT EXISTS diagnostic_assessments (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
    self_level TEXT NOT NULL CHECK (self_level IN ('familiar', 'intermediate')),
    status TEXT NOT NULL DEFAULT 'generated' CHECK (status IN ('generating', 'generated', 'in_progress', 'completed', 'failed', 'expired')),
    question_count INTEGER NOT NULL DEFAULT 0 CHECK (question_count >= 0),
    min_questions INTEGER NOT NULL DEFAULT 5 CHECK (min_questions >= 1),
    max_questions INTEGER NOT NULL DEFAULT 8 CHECK (max_questions >= min_questions),
    answered_count INTEGER NOT NULL DEFAULT 0 CHECK (answered_count >= 0),
    adaptive_state_json TEXT NOT NULL DEFAULT '{}',
    source TEXT NOT NULL DEFAULT 'llm' CHECK (source IN ('llm', 'rules', 'manual')),
    provider TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_diagnostic_assessments_goal ON diagnostic_assessments(goal_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_diagnostic_assessments_user_status ON diagnostic_assessments(user_id, status);

  CREATE TABLE IF NOT EXISTS diagnostic_questions (
    id TEXT PRIMARY KEY,
    assessment_id TEXT NOT NULL REFERENCES diagnostic_assessments(id) ON DELETE CASCADE,
    skill_id TEXT REFERENCES goal_skills(id) ON DELETE SET NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    kind TEXT NOT NULL CHECK (kind IN ('concept', 'explanation', 'application', 'debugging', 'design')),
    difficulty INTEGER NOT NULL DEFAULT 2 CHECK (difficulty BETWEEN 1 AND 5),
    prompt TEXT NOT NULL,
    hint TEXT NOT NULL DEFAULT '',
    reference_answer TEXT NOT NULL,
    rubric_json TEXT NOT NULL DEFAULT '{}',
    max_score INTEGER NOT NULL DEFAULT 10 CHECK (max_score > 0),
    generated_by TEXT NOT NULL DEFAULT 'llm' CHECK (generated_by IN ('llm', 'rules', 'manual')),
    created_at TEXT NOT NULL,
    UNIQUE(assessment_id, position)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_diagnostic_questions_assessment ON diagnostic_questions(assessment_id, position);
  CREATE INDEX IF NOT EXISTS idx_diagnostic_questions_skill ON diagnostic_questions(skill_id);

  CREATE TABLE IF NOT EXISTS diagnostic_responses (
    id TEXT PRIMARY KEY,
    assessment_id TEXT NOT NULL REFERENCES diagnostic_assessments(id) ON DELETE CASCADE,
    question_id TEXT NOT NULL REFERENCES diagnostic_questions(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    skill_id TEXT REFERENCES goal_skills(id) ON DELETE SET NULL,
    answer TEXT NOT NULL,
    score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 10),
    max_score INTEGER NOT NULL DEFAULT 10 CHECK (max_score > 0),
    feedback TEXT NOT NULL DEFAULT '',
    grader_mode TEXT NOT NULL CHECK (grader_mode IN ('llm', 'rules', 'manual')),
    provider TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    answered_at TEXT NOT NULL,
    UNIQUE(assessment_id, question_id)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_diagnostic_responses_assessment ON diagnostic_responses(assessment_id, answered_at);
  CREATE INDEX IF NOT EXISTS idx_diagnostic_responses_skill ON diagnostic_responses(skill_id, answered_at);

  CREATE TABLE IF NOT EXISTS diagnostic_attempts (
    id TEXT PRIMARY KEY,
    assessment_id TEXT NOT NULL REFERENCES diagnostic_assessments(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    attempt_number INTEGER NOT NULL DEFAULT 1 CHECK (attempt_number >= 1),
    answers_json TEXT NOT NULL DEFAULT '{}',
    score INTEGER CHECK (score IS NULL OR score BETWEEN 0 AND 100),
    level TEXT CHECK (level IS NULL OR level IN ('unqualified', 'qualified', 'good', 'excellent')),
    feedback_json TEXT NOT NULL DEFAULT '{}',
    skill_scores_json TEXT NOT NULL DEFAULT '{}',
    passed INTEGER NOT NULL DEFAULT 0 CHECK (passed IN (0, 1)),
    grader_mode TEXT NOT NULL DEFAULT 'pending' CHECK (grader_mode IN ('pending', 'llm', 'rules', 'manual')),
    started_at TEXT NOT NULL,
    submitted_at TEXT,
    UNIQUE(assessment_id, attempt_number)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_diagnostic_attempts_user ON diagnostic_attempts(user_id, started_at DESC);

  CREATE TABLE IF NOT EXISTS lesson_assessment_attempts (
    id TEXT PRIMARY KEY,
    lesson_id TEXT NOT NULL REFERENCES course_lessons(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    attempt_number INTEGER NOT NULL DEFAULT 1 CHECK (attempt_number >= 1),
    answers_json TEXT NOT NULL DEFAULT '{}',
    score INTEGER CHECK (score IS NULL OR score BETWEEN 0 AND 100),
    level TEXT CHECK (level IS NULL OR level IN ('unqualified', 'qualified', 'good', 'excellent')),
    feedback_json TEXT NOT NULL DEFAULT '{}',
    skill_scores_json TEXT NOT NULL DEFAULT '{}',
    passed INTEGER NOT NULL DEFAULT 0 CHECK (passed IN (0, 1)),
    grader_mode TEXT NOT NULL DEFAULT 'pending' CHECK (grader_mode IN ('pending', 'llm', 'rules', 'manual')),
    provider TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    submitted_at TEXT,
    UNIQUE(lesson_id, user_id, attempt_number)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_lesson_attempts_user ON lesson_assessment_attempts(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_lesson_attempts_lesson ON lesson_assessment_attempts(lesson_id, attempt_number DESC);

  CREATE TABLE IF NOT EXISTS workflow_runs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    goal_id TEXT REFERENCES goals(id) ON DELETE CASCADE,
    workflow_type TEXT NOT NULL CHECK (workflow_type IN ('goal_onboarding', 'daily_learning', 'lesson_assessment', 'daily_review')),
    thread_id TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'waiting_for_user', 'completed', 'failed', 'cancelled')),
    current_node TEXT NOT NULL DEFAULT '',
    waiting_for TEXT NOT NULL DEFAULT '',
    last_error TEXT NOT NULL DEFAULT '',
    started_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_workflow_runs_user_status ON workflow_runs(user_id, status, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_workflow_runs_goal ON workflow_runs(goal_id, started_at DESC);

  CREATE TABLE IF NOT EXISTS agent_runs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    goal_id TEXT REFERENCES goals(id) ON DELETE SET NULL,
    workflow_run_id TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL,
    agent_type TEXT NOT NULL CHECK (agent_type IN ('planner', 'tutor', 'examiner', 'reviewer', 'router', 'guard')),
    node_name TEXT NOT NULL DEFAULT '',
    input_json TEXT NOT NULL DEFAULT '{}',
    output_json TEXT NOT NULL DEFAULT '{}',
    provider TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    prompt_tokens INTEGER NOT NULL DEFAULT 0 CHECK (prompt_tokens >= 0),
    completion_tokens INTEGER NOT NULL DEFAULT 0 CHECK (completion_tokens >= 0),
    total_tokens INTEGER NOT NULL DEFAULT 0 CHECK (total_tokens >= 0),
    latency_ms INTEGER NOT NULL DEFAULT 0 CHECK (latency_ms >= 0),
    status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed', 'fallback')),
    error_message TEXT NOT NULL DEFAULT '',
    idempotency_key TEXT UNIQUE,
    created_at TEXT NOT NULL,
    completed_at TEXT
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_agent_runs_user_time ON agent_runs(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_agent_runs_workflow ON agent_runs(workflow_run_id, created_at);
`;
