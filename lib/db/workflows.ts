import { randomUUID } from "node:crypto";

import { getDatabase, withTransaction } from "@/lib/db";

export type WorkflowRunStatus = "running" | "waiting_for_user" | "completed" | "failed" | "cancelled";
export type WorkflowEventType = "progress" | "action_requested" | "action_completed" | "waiting" | "completed" | "failed";

export type WorkflowRun = {
  id: string;
  userId: string;
  goalId: string;
  threadId: string;
  status: WorkflowRunStatus;
  currentNode: string;
  waitingFor: string;
  lastError: string;
};

type WorkflowRunRow = {
  id: string;
  user_id: string;
  goal_id: string;
  thread_id: string;
  status: WorkflowRunStatus;
  current_node: string;
  waiting_for: string;
  last_error: string;
};

type WorkflowEventRow = {
  payload_json: string;
};

function toRun(row: WorkflowRunRow): WorkflowRun {
  return {
    id: row.id,
    userId: row.user_id,
    goalId: row.goal_id,
    threadId: row.thread_id,
    status: row.status,
    currentNode: row.current_node,
    waitingFor: row.waiting_for,
    lastError: row.last_error,
  };
}

export function ensureGoalOnboardingRun(userId: string, goalId: string): WorkflowRun {
  const existing = getDatabase().prepare(`
    SELECT id, user_id, goal_id, thread_id, status, current_node, waiting_for, last_error
    FROM workflow_runs
    WHERE user_id = ? AND goal_id = ? AND workflow_type = 'goal_onboarding'
      AND status != 'cancelled'
    ORDER BY started_at DESC LIMIT 1
  `).get(userId, goalId) as WorkflowRunRow | undefined;
  if (existing && existing.status !== "failed") return toRun(existing);

  const owned = getDatabase().prepare("SELECT id FROM goals WHERE id = ? AND user_id = ?").get(goalId, userId);
  if (!owned) throw new Error("找不到这个目标。");
  const id = randomUUID();
  const threadId = `goal-onboarding:${goalId}:${randomUUID()}`;
  const now = new Date().toISOString();
  getDatabase().prepare(`
    INSERT INTO workflow_runs (
      id, user_id, goal_id, workflow_type, thread_id, status, current_node,
      waiting_for, last_error, started_at, updated_at
    ) VALUES (?, ?, ?, 'goal_onboarding', ?, 'running', 'start', '', '', ?, ?)
  `).run(id, userId, goalId, threadId, now, now);
  return {
    id, userId, goalId, threadId, status: "running", currentNode: "start", waitingFor: "", lastError: "",
  };
}

export function updateWorkflowRun(input: {
  runId: string;
  userId: string;
  status: WorkflowRunStatus;
  currentNode: string;
  waitingFor?: string;
  lastError?: string;
}) {
  const now = new Date().toISOString();
  const result = getDatabase().prepare(`
    UPDATE workflow_runs
    SET status = ?, current_node = ?, waiting_for = ?, last_error = ?, updated_at = ?,
        completed_at = CASE WHEN ? = 'completed' THEN COALESCE(completed_at, ?) ELSE completed_at END
    WHERE id = ? AND user_id = ?
  `).run(
    input.status,
    input.currentNode.slice(0, 120),
    (input.waitingFor || "").slice(0, 120),
    (input.lastError || "").slice(0, 2000),
    now,
    input.status,
    now,
    input.runId,
    input.userId,
  );
  if (result.changes !== 1) throw new Error("工作流状态不存在或不属于当前用户。");
}

export function appendWorkflowEvent(input: {
  runId: string;
  eventType: WorkflowEventType;
  nodeName?: string;
  idempotencyKey?: string;
  payload?: unknown;
}) {
  const now = new Date().toISOString();
  return withTransaction((database) => {
    const next = database.prepare(`
      SELECT COALESCE(MAX(event_index), 0) + 1 AS event_index
      FROM workflow_events WHERE workflow_run_id = ?
    `).get(input.runId) as { event_index: number };
    database.prepare(`
      INSERT OR IGNORE INTO workflow_events (
        id, workflow_run_id, event_index, event_type, node_name,
        idempotency_key, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(), input.runId, next.event_index, input.eventType,
      (input.nodeName || "").slice(0, 120),
      (input.idempotencyKey || "").slice(0, 240),
      JSON.stringify(input.payload ?? {}), now,
    );
    return next.event_index;
  });
}

export function readWorkflowActionResult(runId: string, idempotencyKey: string) {
  const row = getDatabase().prepare(`
    SELECT payload_json FROM workflow_events
    WHERE workflow_run_id = ? AND event_type = 'action_completed' AND idempotency_key = ?
    LIMIT 1
  `).get(runId, idempotencyKey) as WorkflowEventRow | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.payload_json) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function saveWorkflowActionResult(input: {
  runId: string;
  action: string;
  idempotencyKey: string;
  data: Record<string, unknown>;
}) {
  const existing = readWorkflowActionResult(input.runId, input.idempotencyKey);
  if (existing) return existing;
  try {
    appendWorkflowEvent({
      runId: input.runId,
      eventType: "action_completed",
      nodeName: input.action,
      idempotencyKey: input.idempotencyKey,
      payload: input.data,
    });
  } catch (error) {
    const raced = readWorkflowActionResult(input.runId, input.idempotencyKey);
    if (raced) return raced;
    throw error;
  }
  return input.data;
}
