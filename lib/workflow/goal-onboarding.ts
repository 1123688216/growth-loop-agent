import { createHash } from "node:crypto";
import { SourceSelectionRequired } from "../learning-loop/lesson-evidence.ts";

import type { GoalContext, PersistedSkill } from "@/lib/agents/types";
import { readGoalWithProfile } from "@/lib/db/goals";
import { readActiveDiagnostic } from "@/lib/db/learning-loop";
import { readLearningProgramForGoal } from "@/lib/db/programs";
import { readGate, gateIdentity } from "@/lib/db/knowledge-gates";
import { resolveTutorKnowledge } from "@/lib/knowledge/resolve-knowledge";
import {
  appendWorkflowEvent,
  ensureGoalOnboardingRun,
  readWorkflowActionResult,
  saveWorkflowActionResult,
  updateWorkflowRun,
  type WorkflowRun,
} from "@/lib/db/workflows";
import {
  ensureSkillsForGoal,
  generateCourseForGoal,
  prepareGoalLoop,
  type LearningPreparationReporter,
} from "@/lib/learning-loop/service";
import type { GoalPreparation, LearningProgram } from "@/lib/learning-program/types";
import {
  advanceWorkflowService,
  workflowServiceConfigured,
  type WorkflowServiceResponse,
} from "@/lib/workflow/client";

type UserResumeEvent = "diagnostic_completed" | "sources_updated";

function envFlag(name: string, fallback = false) {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value);
}

function asGoalContext(goal: NonNullable<ReturnType<typeof readGoalWithProfile>>): GoalContext {
  return {
    id: goal.id,
    title: goal.title,
    description: goal.description || `完成「${goal.title}」并留下可验证成果。`,
    background: goal.background,
    selfLevel: goal.selfLevel,
    weeklyHours: goal.weeklyHours,
    targetDate: goal.targetDate,
  };
}

function publicSkills(skills: PersistedSkill[]) {
  return skills.map((skill) => ({ id: skill.id, name: skill.name, description: skill.description }));
}

async function emitProgress(
  run: WorkflowRun,
  reporter: LearningPreparationReporter | undefined,
  progress: { stage: string; percent: number; message: string },
) {
  const fingerprint = createHash("sha256")
    .update(`${progress.stage}:${progress.percent}:${progress.message}`)
    .digest("hex")
    .slice(0, 24);
  appendWorkflowEvent({
    runId: run.id,
    eventType: "progress",
    nodeName: progress.stage,
    idempotencyKey: `progress:${fingerprint}`,
    payload: progress,
  });
  await reporter?.(progress as Parameters<LearningPreparationReporter>[0]);
}

async function executeAction(input: {
  run: WorkflowRun;
  userId: string;
  goalId: string;
  response: WorkflowServiceResponse;
  reporter?: LearningPreparationReporter;
}) {
  const pending = input.response.interrupt?.value;
  const action = pending?.action?.trim() || "";
  const idempotencyKey = pending?.idempotency_key?.trim() || "";
  if (!action || !idempotencyKey) throw new Error("工作流动作缺少名称或幂等键。");
  const cached = readWorkflowActionResult(input.run.id, idempotencyKey);
  if (cached) {
    return { event: "action_completed", action, idempotency_key: idempotencyKey, data: cached };
  }

  appendWorkflowEvent({
    runId: input.run.id,
    eventType: "action_requested",
    nodeName: action,
    idempotencyKey: `request:${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 24)}`,
    payload: pending?.payload || {},
  });
  let data: Record<string, unknown>;
  if (action === "load_goal") {
    const goal = readGoalWithProfile(input.userId, input.goalId);
    if (!goal) throw new Error("找不到这个目标。");
    const existing = readLearningProgramForGoal(input.userId, input.goalId);
    data = {
      goal: {
        id: goal.id,
        title: goal.title,
        description: goal.description,
        background: goal.background,
        self_level: goal.selfLevel,
        diagnostic_required: goal.diagnosticRequired,
        diagnostic_status: goal.diagnosticStatus,
        source_scope_mode: goal.sourceScopeMode || "auto",
      },
      program_id: existing?.programId || "",
      auto_web: envFlag("WORKFLOW_AUTO_WEB", true),
      lesson_level_gate: true,
    };
  } else if (action === "ensure_skills") {
    const goal = readGoalWithProfile(input.userId, input.goalId);
    if (!goal) throw new Error("找不到这个目标。");
    const skills = await ensureSkillsForGoal(input.userId, asGoalContext(goal), async (progress) => {
      await emitProgress(input.run, input.reporter, progress);
    });
    data = { skills: publicSkills(skills) };
  } else if (action === "prepare_diagnostic") {
    const preparation = await prepareGoalLoop(input.userId, input.goalId, async (progress) => {
      await emitProgress(input.run, input.reporter, progress);
    });
    if (preparation.nextAction !== "diagnostic" || !preparation.diagnostic) {
      throw new Error("工作流要求诊断，但业务服务没有返回诊断记录。");
    }
    data = { diagnostic_id: preparation.diagnostic.id };
  } else if (action === "retrieve_evidence") {
    const goal = readGoalWithProfile(input.userId,input.goalId);
    if (!goal) throw new Error("找不到目标。");
    const actionKey = 'onboarding:' + goal.title;
    let evidence;
    try {
      evidence = await resolveTutorKnowledge({userId:input.userId,goalId:input.goalId,actionKey,
        action:{message:goal.title + ' ' + goal.description,generatingLesson:true},
        report:async message=>{await emitProgress(input.run,input.reporter,{stage:"sources",percent:65,message});}});
    } catch(error) {
      if (!(error instanceof SourceSelectionRequired)) throw error;
      const row = readGate(gateIdentity(input.userId,input.goalId,actionKey));
      evidence = row ? JSON.parse(row.evidence_json) : null;
      if (!evidence) throw error;
    }
    data = {knowledge_advisory:!evidence,evidence:{retrieval_run_id:evidence?.retrievalRunId || '',status:evidence?.status || 'insufficient',
      result_count:evidence?.resultCount || 0,total_evidence_tokens:evidence?.totalEvidenceTokens || 0,
      insufficiency_reason:evidence?.insufficiencyReason || '模型知识生成，未经资料验证'}};
  } else if (action === "supplement_web") {
    // Knowledge Gate already performed the single discovery round; do not search twice.
    const reason = input.response.state.evidence?.insufficiency_reason || '';
    data = {message:reason.startsWith('waiting_for_sources：搜索未完成') ? reason : "waiting_for_sources：请确认候选资料并收录后继续。"};
  } else if (action === "generate_course") {
    const payload = pending?.payload || {};
    const retrievalRunId = payload.evidence_status === "sufficient" && typeof payload.retrieval_run_id === "string"
      ? payload.retrieval_run_id : undefined;
    const program = await generateCourseForGoal(input.userId, input.goalId, undefined, async (progress) => {
      await emitProgress(input.run, input.reporter, progress);
    }, retrievalRunId);
    data = { program_id: program.programId };
  } else {
    throw new Error(`工作流请求了未知动作：${action}`);
  }
  const saved = saveWorkflowActionResult({ runId: input.run.id, action, idempotencyKey, data });
  return { event: "action_completed", action, idempotency_key: idempotencyKey, data: saved };
}

async function asPreparation(
  userId: string,
  goalId: string,
  response: WorkflowServiceResponse,
): Promise<GoalPreparation> {
  if (response.status === "completed") {
    const program = readLearningProgramForGoal(userId, goalId);
    if (!program) throw new Error("工作流已经完成，但课程记录无法读取。");
    return { nextAction: "course", program };
  }
  if (response.status === "waiting_for_user" && response.waiting_for === "diagnostic") {
    const diagnostic = readActiveDiagnostic(userId, goalId);
    if (!diagnostic) throw new Error("工作流正在等待诊断，但诊断记录无法读取。");
    return { nextAction: "diagnostic", diagnostic };
  }
  if (response.status === "waiting_for_user" && response.waiting_for === "sources") {
    return {
      nextAction: "sources",
      sourceWait: {
        threadId: response.thread_id,
        retrievalRunId: response.state.evidence?.retrieval_run_id || "",
        reason: response.state.evidence?.insufficiency_reason || response.interrupt?.value.reason || "source_insufficient",
        message: response.interrupt?.value.message || "资料不足，请上传或调整资料范围后继续。",
      },
    };
  }
  throw new Error(`工作流停在无法处理的状态：${response.status}/${response.waiting_for || response.current_node}`);
}

export async function runGoalOnboardingWorkflow(input: {
  userId: string;
  goalId: string;
  reporter?: LearningPreparationReporter;
  resumeEvent?: UserResumeEvent;
}): Promise<GoalPreparation> {
  if (!workflowServiceConfigured()) {
    await input.reporter?.({ stage: "sources", percent: 5,
      message: "未配置 Workflow 服务，当前使用旧课程准备流程，不会自动联网补充资料；请配置 WORKFLOW_SERVICE_URL 后使用自动资料决策。" });
    return prepareGoalLoop(input.userId, input.goalId, input.reporter);
  }
  const run = ensureGoalOnboardingRun(input.userId, input.goalId);
  const seenProgress = new Set<string>();
  let pendingResume = input.resumeEvent;
  let response: WorkflowServiceResponse;
  try {
    response = await advanceWorkflowService({
      threadId: run.threadId,
      userId: input.userId,
      goalId: input.goalId,
      requireSources: envFlag("WORKFLOW_REQUIRE_SOURCES"),
    });
    for (let step = 0; step < 32; step += 1) {
      for (const progress of response.state.progress || []) {
        const key = `${progress.stage}:${progress.percent}:${progress.message}`;
        if (seenProgress.has(key)) continue;
        seenProgress.add(key);
        await emitProgress(run, input.reporter, progress);
      }
      if (response.status === "waiting_for_action") {
        const resume = await executeAction({ ...input, run, response });
        response = await advanceWorkflowService({
          threadId: run.threadId,
          userId: input.userId,
          goalId: input.goalId,
          requireSources: envFlag("WORKFLOW_REQUIRE_SOURCES"),
          resume,
        });
        continue;
      }
      if (response.status === "waiting_for_user" && pendingResume) {
        const expected = pendingResume === "diagnostic_completed" ? "diagnostic" : "sources";
        if (response.waiting_for !== expected) {
          throw new Error(`工作流正在等待 ${response.waiting_for}，不能接收 ${pendingResume}。`);
        }
        response = await advanceWorkflowService({
          threadId: run.threadId,
          userId: input.userId,
          goalId: input.goalId,
          requireSources: envFlag("WORKFLOW_REQUIRE_SOURCES"),
          resume: { event: pendingResume },
        });
        pendingResume = undefined;
        continue;
      }
      const status = response.status === "completed" ? "completed" : response.status === "waiting_for_user" ? "waiting_for_user" : "running";
      updateWorkflowRun({ runId: run.id, userId: input.userId, status, currentNode: response.current_node, waitingFor: response.waiting_for });
      appendWorkflowEvent({
        runId: run.id,
        eventType: response.status === "completed" ? "completed" : "waiting",
        nodeName: response.current_node,
        idempotencyKey: `terminal:${response.status}:${response.waiting_for || response.current_node}`,
        payload: { status: response.status, waitingFor: response.waiting_for },
      });
      return asPreparation(input.userId, input.goalId, response);
    }
    throw new Error("工作流动作次数超过安全上限。");
  } catch (error) {
    const message = error instanceof Error ? error.message : "学习工作流失败。";
    if(error instanceof SourceSelectionRequired) {
      updateWorkflowRun({runId:run.id,userId:input.userId,status:'waiting_for_user',currentNode:'knowledge_gate',waitingFor:'sources'});
      appendWorkflowEvent({runId:run.id,eventType:'waiting',nodeName:'knowledge_gate',payload:{message}});
      return {nextAction:'sources',sourceWait:{threadId:run.threadId,retrievalRunId:'',reason:'waiting_for_sources',message}};
    }
    updateWorkflowRun({ runId: run.id, userId: input.userId, status: "failed", currentNode: "error", lastError: message });
    appendWorkflowEvent({ runId: run.id, eventType: "failed", nodeName: "error", payload: { message } });
    throw error;
  }
}

export async function resumeGoalOnboardingAfterDiagnostic(input: {
  userId: string;
  goalId: string;
  reporter?: LearningPreparationReporter;
}): Promise<LearningProgram> {
  const preparation = await runGoalOnboardingWorkflow({ ...input, resumeEvent: "diagnostic_completed" });
  if (preparation.nextAction === "course" && preparation.program) return preparation.program;
  if (preparation.nextAction === "sources") throw new SourceSelectionRequired(preparation.sourceWait.message);
  throw new Error("诊断已完成，但工作流仍未进入课程生成阶段。");
}
