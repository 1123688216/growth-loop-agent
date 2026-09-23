import { getCurrentUser } from "@/lib/auth/session";
import { importWebBatch, ingestWebTool, searchWebTool } from "@/lib/knowledge/web-tools";
import { WebSourceError } from "@/lib/knowledge/web-provider";
import { runWebResearch } from "@/lib/workflow/web-research";
import { getDatabase } from "@/lib/db";
import { waitingGate } from '@/lib/db/knowledge-gates';

export const runtime = "nodejs";

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "未登录。" }, { status: 401 });
  const goalId = new URL(request.url).searchParams.get("goalId") || "";
  const db = getDatabase();
  if (!db.prepare("SELECT id FROM goals WHERE id=? AND user_id=?").get(goalId, user.id)) return Response.json({ error: "目标不存在。" }, { status: 404 });
  const batch = db.prepare(`SELECT started_at, completed_at FROM pipeline_runs WHERE user_id=?
    AND status='completed' AND json_extract(config_json,'$.purpose')='web_search'
    AND json_extract(config_json,'$.goalId')=? ORDER BY rowid DESC LIMIT 1`).get(user.id, goalId) as
    { started_at: string; completed_at: string } | undefined;
  const candidates = batch ? db.prepare(`SELECT id,title,url,snippet FROM web_search_candidates
    WHERE user_id=? AND goal_id=? AND created_at>=? AND created_at<=? ORDER BY rowid DESC LIMIT 5`)
    .all(user.id, goalId, batch.started_at, batch.completed_at) : [];
  const gate = waitingGate(user.id,goalId);
  const gateCandidates = gate ? db.prepare(`SELECT c.id,c.title,c.url,c.snippet FROM web_search_candidates c
    JOIN knowledge_gate_candidates b ON b.candidate_id=c.id WHERE b.gate_id=? AND c.user_id=? AND c.goal_id=?
    AND c.snippet!='selected-directory-child' ORDER BY c.rowid LIMIT 5`).all(gate.id,user.id,goalId) : [];
  return Response.json({ candidates: batch ? candidates.reverse() : gateCandidates,
    knowledgeGate:gate ? {status:gate.status}:null }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "未登录。" }, { status: 401 });
  try {
    const body = await request.json();
    if (!body || typeof body.goalId !== "string") return Response.json({ error: "缺少目标。" }, { status: 400 });
    const context = { userId: user.id, goalId: body.goalId, trigger:'user' as const };
    if (body.action === "import-batch") {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          const send = (event: Record<string, unknown>) => {
            try { controller.enqueue(encoder.encode(JSON.stringify(event) + "\n")); } catch { /* Client disconnected. */ }
          };
          try { await importWebBatch(context, body.candidateIds, typeof body.description === "string" ? body.description.slice(0,1000) : "", send); }
          catch (error) { send({type:"error",error:error instanceof WebSourceError ? error.message : "批次处理失败。"}); }
          finally { try { controller.close(); } catch { /* Already disconnected. */ } }
        }
      });
      return new Response(stream, {headers:{"Content-Type":"application/x-ndjson; charset=utf-8","Cache-Control":"no-store, no-transform","X-Accel-Buffering":"no"}});
    }
    if (body.action === "research") {
      return Response.json(await runWebResearch({ ...context,
        query: typeof body.query === "string" ? body.query : undefined,
        runId: typeof body.runId === "string" ? body.runId : undefined,
        candidateId: typeof body.candidateId === "string" ? body.candidateId : undefined,
        description: typeof body.description === "string" ? body.description : undefined,
        requirements: typeof body.requirements === "string" ? body.requirements : undefined,
        finish: body.finish === true,
      }));
    }
    if (body.action === "search" && typeof body.query === "string") {
      return Response.json(await searchWebTool(context, body.query));
    }
    if (body.action === "import" && typeof body.candidateId === "string") {
      return Response.json(await ingestWebTool(context, body.candidateId, typeof body.description === "string" ? body.description : ""));
    }
    return Response.json({ error: "请求参数不正确。" }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error instanceof WebSourceError ? error.message : "联网资料处理失败，请稍后重试。" },
      { status: error instanceof WebSourceError ? error.status : 502 });
  }
}
