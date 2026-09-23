export type WorkflowInterrupt = {
  id: string;
  value: {
    kind?: "action" | "user_input";
    action?: string;
    idempotency_key?: string;
    waiting_for?: string;
    message?: string;
    reason?: string;
    payload?: Record<string, unknown>;
  };
};

export type WorkflowServiceResponse = {
  thread_id: string;
  status: "running" | "waiting_for_action" | "waiting_for_user" | "completed" | "failed";
  current_node: string;
  waiting_for: string;
  interrupt: WorkflowInterrupt | null;
  state: {
    web_attempted?: boolean;
    program_id?: string;
    diagnostic_id?: string;
    progress?: Array<{ stage: string; percent: number; message: string }>;
    evidence?: {
      retrieval_run_id?: string;
      insufficiency_reason?: string;
    };
  };
};

export class WorkflowServiceError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export function workflowServiceConfigured() {
  return Boolean(process.env.WORKFLOW_SERVICE_URL?.trim());
}

export async function advanceWorkflowService(input: {
  threadId: string;
  userId: string;
  goalId: string;
  requireSources: boolean;
  resume?: Record<string, unknown>;
}): Promise<WorkflowServiceResponse> {
  const baseUrl = process.env.WORKFLOW_SERVICE_URL?.trim().replace(/\/$/, "");
  if (!baseUrl) throw new WorkflowServiceError("工作流服务尚未配置。", 503);
  const timeout = Math.max(5_000, Math.min(120_000, Number(process.env.WORKFLOW_SERVICE_TIMEOUT_MS) || 45_000));
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/v1/goal-onboarding/advance`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.WORKFLOW_SERVICE_TOKEN?.trim()
          ? { "X-Workflow-Token": process.env.WORKFLOW_SERVICE_TOKEN.trim() }
          : {}),
      },
      body: JSON.stringify({
        thread_id: input.threadId,
        user_id: input.userId,
        goal_id: input.goalId,
        require_sources: input.requireSources,
        ...(input.resume ? { resume: input.resume } : {}),
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(timeout),
    });
  } catch (error) {
    throw new WorkflowServiceError(
      error instanceof Error ? `工作流服务不可用：${error.message}` : "工作流服务不可用。",
      503,
    );
  }
  const payload = await response.json().catch(() => ({})) as Partial<WorkflowServiceResponse> & { detail?: unknown };
  if (!response.ok) {
    const detail = typeof payload.detail === "string" ? payload.detail : `HTTP ${response.status}`;
    throw new WorkflowServiceError(`工作流推进失败：${detail}`, response.status);
  }
  if (!payload.thread_id || !payload.status || !payload.state) {
    throw new WorkflowServiceError("工作流服务返回了不完整的状态。", 502);
  }
  return payload as WorkflowServiceResponse;
}
