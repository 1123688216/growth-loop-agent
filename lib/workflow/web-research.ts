import { randomUUID } from "node:crypto";
import { getDatabase } from "../db/index.ts";
import { ingestWebTool, searchWebTool } from "../knowledge/web-tools.ts";
import { WebSourceError } from "../knowledge/web-provider.ts";

type Candidate = { id: string; title: string; url: string; snippet: string };
type WebResponse = {
  status: string;
  interrupt?: { value: { action?: string; idempotency_key?: string; payload?: Record<string, string> } };
  state: { candidates?: Candidate[]; recommendations?: Array<{ candidate_id: string; reason: string }>; attempt?: number;
    result?: { sourceId: string; message: string }; planner_mode?: string };
};

type ResearchInput = {
  userId: string; goalId: string; query?: string; runId?: string;
  candidateId?: string; description?: string; finish?: boolean; requirements?: string;
  automatic?: boolean;
  knowledgeGateId?: string;
  /** Server-only stable identifier for a parent workflow action. */
  workflowKey?: string;
  onProgress?: (message: string) => Promise<void>;
};

// Serialize this demo's same-user/goal requests, including all external-action round trips.
const gates = new Map<string, Promise<void>>();
export async function runWebResearch(input: ResearchInput) {
  const key = `${input.userId}:${input.goalId}`;
  const previous = gates.get(key) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  gates.set(key, current);
  await previous;
  try { return await executeWebResearch(input); }
  finally { release(); if (gates.get(key) === current) gates.delete(key); }
}

async function executeWebResearch(input: ResearchInput) {
  const started = performance.now();
  const db = getDatabase();
  if (!db.prepare("SELECT id FROM goals WHERE user_id = ? AND id = ?").get(input.userId, input.goalId)) throw new WebSourceError("目标不存在。", 404);
  const base = process.env.WORKFLOW_SERVICE_URL?.trim().replace(/\/$/, "");
  if (!base) throw new WebSourceError("请配置并启动 workflow service 后使用研究流程。", 503);
  let runId = input.runId || input.workflowKey;
  let query = input.query?.trim() || "";
  if (!input.runId && !input.workflowKey && input.requirements?.trim()) query += `\n补充要求（优先遵循）：${input.requirements.trim()}`;
  if (input.workflowKey && query && query.length <= 500) {
    db.prepare("INSERT OR IGNORE INTO web_research_runs (id, user_id, goal_id, query, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(input.workflowKey, input.userId, input.goalId, query, new Date().toISOString());
  }
  if (runId) {
    const run = db.prepare("SELECT query FROM web_research_runs WHERE id = ? AND user_id = ? AND goal_id = ?")
      .get(runId, input.userId, input.goalId) as { query: string } | undefined;
    if (!run) throw new WebSourceError("研究记录不存在。", 404);
    query = run.query;
  } else {
    if (!query || query.length > 2000) throw new WebSourceError("研究需求与补充要求合计不能超过 2000 字。");
    runId = `web-research:${randomUUID()}`;
    db.prepare("INSERT INTO web_research_runs (id, user_id, goal_id, query, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(runId, input.userId, input.goalId, query, new Date().toISOString());
  }
  async function advance(resume?: Record<string, unknown>): Promise<WebResponse> {
    const response = await fetch(`${base}/v1/web-research/advance`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Workflow-Token": process.env.WORKFLOW_SERVICE_TOKEN || "" },
      body: JSON.stringify({ thread_id: runId, user_id: input.userId, goal_id: input.goalId, query, resume }),
      signal: AbortSignal.timeout(120_000), cache: "no-store",
    });
    if (!response.ok) throw new WebSourceError(`研究工作流失败（${response.status}），可点击恢复重试。`, 502);
    return response.json();
  }
  let selected = input.candidateId !== undefined || input.finish;
  try {
    let response = await advance();
    for (let step = 0; step < 10; step++) {
      if (response.status === "waiting_for_action") {
        const pending = response.interrupt?.value;
        const key = pending?.idempotency_key;
        if (!key || !pending?.action) throw new WebSourceError("工作流动作不完整。", 502);
        const cached = db.prepare("SELECT result_json FROM web_research_actions WHERE run_id = ? AND action_key = ?")
          .get(runId, key) as { result_json: string } | undefined;
        let data: unknown;
        if (cached) data = JSON.parse(cached.result_json);
        else {
          const context = { userId: input.userId, goalId: input.goalId };
          if (pending.action === "web_search") {
            await input.onProgress?.("正在联网搜索补充资料，本次执行一轮搜索；用户可主动补充要求后换批。不会把搜索摘要直接作为课程依据。");
            data = await searchWebTool({...context,knowledgeGateId:input.knowledgeGateId}, pending.payload?.query || "");
          } else if (pending.action === "web_import") {
            if (input.automatic) return { runId, status: "needs_selection", message: "请在资料范围中多选确认来源后再收录，旧的自动收录已暂停。" };
            await input.onProgress?.("正在提取推荐网页正文、切片并建立索引，完成后重新检索。");
            data = await ingestWebTool({...context,trigger:'user'}, pending.payload?.candidate_id || "", pending.payload?.description || "");
          }
          else throw new WebSourceError("未知研究动作。", 502);
          db.prepare("INSERT OR IGNORE INTO web_research_actions (run_id, action_key, result_json) VALUES (?, ?, ?)").run(runId, key, JSON.stringify(data));
        }
        response = await advance({ action: pending.action, idempotency_key: key, data });
        continue;
      }
      if (response.status === "waiting_for_user" && input.automatic) {
        return { runId, status: "needs_selection", candidates: response.state.candidates || [],
          message: "已找到搜索摘要，请打开目标的「资料范围 → 联网补充资料」多选确认。确认前不会抓取正文或向量化。" };
      }
      if (response.status === "waiting_for_user" && selected) {
        selected = false;
        response = await advance({ candidate_id: input.candidateId || "", description: input.description || "" });
        continue;
      }
      return { runId, candidates: response.state.candidates || [], recommendations: response.state.recommendations || [],
        status: response.status, plannerMode: response.state.planner_mode, attempts: response.state.attempt,
        durationMs: Math.round(performance.now() - started), ...response.state.result };
    }
    throw new WebSourceError("研究流程超过动作上限。", 502);
  } catch (error) {
    // Surface the durable ID even when the first HTTP request fails.
    return { runId, error: error instanceof WebSourceError ? error.message : "研究服务暂不可用，请恢复重试。", status: "failed" };
  }
}
