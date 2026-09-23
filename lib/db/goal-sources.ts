import { getDatabase, withTransaction } from "./index.ts";
import { listKnowledgeSources } from "./knowledge-sources.ts";
import type {
  GoalSourceLinkStatus,
  GoalSourceScope,
  GoalSourceScopeMode,
  KnowledgeSourceSummary,
} from "../knowledge/types.ts";

type GoalScopeRow = {
  id: string;
  source_scope_mode: GoalSourceScopeMode;
};

type GoalSourceLinkRow = {
  source_id: string;
  status: GoalSourceLinkStatus;
};

export type ResolvedGoalSource = {
  id: string;
  title: string;
  description: string;
  status: KnowledgeSourceSummary["status"];
  activeChunkSetId: string | null;
  currentVersionId: string | null;
  chunkCount: number;
};

export class GoalSourceScopeError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

function readGoalScopeRow(userId: string, goalId: string): GoalScopeRow | null {
  const row = getDatabase().prepare(`
    SELECT goals.id, COALESCE(profile.source_scope_mode, 'auto') AS source_scope_mode
    FROM goals
    LEFT JOIN goal_learning_profiles AS profile ON profile.goal_id = goals.id
    WHERE goals.id = ? AND goals.user_id = ? AND goals.status != 'archived'
  `).get(goalId, userId) as GoalScopeRow | undefined;
  return row || null;
}

function readLinks(userId: string, goalId: string) {
  return getDatabase().prepare(`
    SELECT source_id, status
    FROM goal_source_links
    WHERE user_id = ? AND goal_id = ?
  `).all(userId, goalId) as GoalSourceLinkRow[];
}

export function readGoalSourceScope(userId: string, goalId: string): GoalSourceScope | null {
  const goal = readGoalScopeRow(userId, goalId);
  if (!goal) return null;
  const links = new Map(readLinks(userId, goalId).map((link) => [link.source_id, link.status]));
  const sources = listKnowledgeSources(userId).map((source) => {
    const linkStatus = links.get(source.id) || null;
    const included = goal.source_scope_mode === "auto"
      ? linkStatus !== "disabled"
      : linkStatus === "active";
    return {
      source,
      linkStatus,
      included,
      inclusionReason: included
        ? goal.source_scope_mode === "auto" ? "automatic" as const : "selected" as const
        : linkStatus === "disabled" ? "excluded" as const : "not_selected" as const,
    };
  });
  return {
    goalId,
    mode: goal.source_scope_mode,
    sources,
    includedSourceIds: sources.filter((item) => item.included).map((item) => item.source.id),
    excludedSourceIds: sources.filter((item) => item.linkStatus === "disabled").map((item) => item.source.id),
  };
}

function normalizedIds(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function updateGoalSourceScope(input: {
  userId: string;
  goalId: string;
  mode: GoalSourceScopeMode;
  includedSourceIds?: string[];
  excludedSourceIds?: string[];
}): GoalSourceScope {
  if (input.mode !== "auto" && input.mode !== "selected") {
    throw new GoalSourceScopeError("资料范围模式不正确。", 400);
  }
  const includedSourceIds = normalizedIds(input.includedSourceIds || []);
  const excludedSourceIds = normalizedIds(input.excludedSourceIds || []);
  const requestedIds = input.mode === "auto" ? excludedSourceIds : includedSourceIds;
  if (requestedIds.length > 200) throw new GoalSourceScopeError("一次最多调整 200 份资料。", 400);

  withTransaction((database) => {
    const goal = readGoalScopeRow(input.userId, input.goalId);
    if (!goal) throw new GoalSourceScopeError("找不到这个学习目标。", 404);

    if (requestedIds.length) {
      const placeholders = requestedIds.map(() => "?").join(", ");
      const owned = database.prepare(`
        SELECT id FROM knowledge_sources
        WHERE user_id = ? AND status != 'deleted' AND id IN (${placeholders})
      `).all(input.userId, ...requestedIds) as Array<{ id: string }>;
      if (owned.length !== requestedIds.length) {
        throw new GoalSourceScopeError("资料不存在、已删除或不属于当前用户。", 403);
      }
    }

    const updated = database.prepare(`
      UPDATE goal_learning_profiles
      SET source_scope_mode = ?, updated_at = ?
      WHERE goal_id = ? AND user_id = ?
    `).run(input.mode, new Date().toISOString(), input.goalId, input.userId);
    if (updated.changes === 0) {
      const now = new Date().toISOString();
      database.prepare(`
        INSERT INTO goal_learning_profiles (
          goal_id, user_id, self_level, weekly_hours, diagnostic_required,
          diagnostic_status, source_scope_mode, created_at, updated_at
        ) VALUES (?, ?, 'beginner', 4, 0, 'skipped', ?, ?, ?)
      `).run(input.goalId, input.userId, input.mode, now, now);
    }
    database.prepare("DELETE FROM goal_source_links WHERE goal_id = ? AND user_id = ?")
      .run(input.goalId, input.userId);

    const now = new Date().toISOString();
    const insert = database.prepare(`
      INSERT INTO goal_source_links (goal_id, source_id, user_id, status, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    if (input.mode === "auto") {
      excludedSourceIds.forEach((sourceId) => insert.run(input.goalId, sourceId, input.userId, "disabled", now));
    } else {
      includedSourceIds.forEach((sourceId) => insert.run(input.goalId, sourceId, input.userId, "active", now));
    }
  });

  const scope = readGoalSourceScope(input.userId, input.goalId);
  if (!scope) throw new GoalSourceScopeError("资料范围保存后无法读取。", 500);
  return scope;
}

export function resolveGoalSources(userId: string, goalId: string) {
  const goal = readGoalScopeRow(userId, goalId);
  if (!goal) throw new GoalSourceScopeError("找不到这个学习目标。", 404);
  const links = new Map(readLinks(userId, goalId).map((link) => [link.source_id, link.status]));
  const rows = getDatabase().prepare(`
    SELECT id, title, description, status, active_chunk_set_id, current_version_id, chunk_count
    FROM knowledge_sources
    WHERE user_id = ? AND status != 'deleted'
    ORDER BY updated_at DESC
  `).all(userId) as Array<{
    id: string;
    title: string;
    description: string;
    status: KnowledgeSourceSummary["status"];
    active_chunk_set_id: string | null;
    current_version_id: string | null;
    chunk_count: number;
  }>;
  const included = rows.filter((source) => goal.source_scope_mode === "auto"
    ? links.get(source.id) !== "disabled"
    : links.get(source.id) === "active");
  return {
    mode: goal.source_scope_mode,
    sources: included.map((source): ResolvedGoalSource => ({
      id: source.id,
      title: source.title,
      description: source.description,
      status: source.status,
      activeChunkSetId: source.active_chunk_set_id,
      currentVersionId: source.current_version_id,
      chunkCount: Number(source.chunk_count || 0),
    })),
  };
}
