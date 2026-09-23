import { createHash, randomUUID } from 'node:crypto';
import { resolveGoalSources } from '../db/goal-sources.ts';
import { createGate, gateIdentity, readGate, saveGate, replaceGateDecision } from '../db/knowledge-gates.ts';
import { searchKnowledgeBaseTool } from './search-tool.ts';
import { decideTutorKnowledge, enforceKnowledgeDecision, knowledgeActionFingerprint, type KnowledgeAction, type TutorKnowledgeDecision } from './knowledge-gate.ts';
import type { EvidenceBundle } from '../db/retrieval.ts';
import { runWebResearch } from '../workflow/web-research.ts';
import { SourceSelectionRequired } from '../learning-loop/lesson-evidence.ts';
import { ingestWebTool } from './web-tools.ts';
import { webPageReviewEnabled } from './web-policy.ts';
import { RagflowServiceError } from './ragflow-client.ts';

export class KnowledgeUnresolved extends Error { readonly code = 'knowledge_unresolved'; }
const running = new Map<string,Promise<EvidenceBundle | null>>();
export async function resolveTutorKnowledge(input: {
  userId:string; goalId:string; actionKey:string; action:KnowledgeAction;
  report?: (message:string)=>Promise<void>;
}): Promise<EvidenceBundle | null> {
  const id = gateIdentity(input.userId,input.goalId,input.actionKey);
  const active = running.get(id);
  if (active) return active;
  const task = execute(); running.set(id,task);
  try { return await task; } finally { running.delete(id); }
  async function execute() {
    const scope = resolveGoalSources(input.userId,input.goalId); // Checks ownership on every replay.
    // A changed ingestion policy must invalidate cached unresolved results from the old blocking gate.
    const ingestionPolicy = ["web-ingestion-policy-v2", webPageReviewEnabled(), 'retrieval-service-recovery-v1', 'topic-balanced-retrieval-v1'];
    const fingerprint = createHash('sha256').update(JSON.stringify([ingestionPolicy, scope.mode,
      scope.sources.map(s=>[s.id,s.currentVersionId,s.activeChunkSetId,s.status]).sort()])).digest('hex');
    let row = readGate(id);
    const actionFingerprint = knowledgeActionFingerprint(input.action,scope.mode);
    const cached = row ? JSON.parse(row.decision_json) : null;
    const proposed: TutorKnowledgeDecision = cached?.actionFingerprint === actionFingerprint ? cached : await decideTutorKnowledge({
      ...input.action, specifiedSources: scope.mode === 'selected' || input.action.specifiedSources,
    });
    const decision = enforceKnowledgeDecision(proposed,{...input.action,specifiedSources:scope.mode==='selected'||input.action.specifiedSources});
    row = row || createGate(id,input.userId,input.goalId,decision);
    if(cached?.actionFingerprint !== actionFingerprint) row = replaceGateDecision(id,decision,actionFingerprint);
    if (decision.knowledgeNeed === 'none') {
      await input.report?.('本次只重述已验证的课程内容，不检索新资料。');
      return null;
    }
    let evidence: EvidenceBundle | null = JSON.parse(row.evidence_json);
    const strict = process.env.KNOWLEDGE_GATE_MODE === 'strict' || decision.knowledgeNeed === 'source_required';
    const unverified = async (reason:string, sourceFingerprint=fingerprint) => {
      saveGate(id,'knowledge_unresolved',evidence,sourceFingerprint);
      if(strict) throw new KnowledgeUnresolved(reason);
      await input.report?.(`资料验证未完成：${reason}。知识门禁为宽松模式，继续生成课程；模型知识生成，未经资料验证。不生成虚构引用，不写入 RAG。`);
      return null;
    };
    const serviceUnavailable = (error: unknown) => {
      // Infrastructure failure is not a durable knowledge gap. Retry on the next
      // user action even when the source fingerprint has not changed.
      saveGate(id, 'service_unavailable', null, fingerprint);
      throw new KnowledgeUnresolved(error instanceof RagflowServiceError
        ? error.message : '本地检索或证据审核服务异常，请恢复服务后重试；本次未判断资料是否充分。');
    };
    if(decision.knowledgeNeed === 'source_required' && scope.mode !== 'selected') {
      saveGate(id,'waiting_for_sources',evidence,fingerprint);
      throw new SourceSelectionRequired('waiting_for_sources：请使用“仅指定资料”勾选教材，不能用全库相关内容替代指定教材。');
    }
    if (row.status === 'resolved' && row.source_fingerprint === fingerprint) return evidence;
    if (!strict && row.status === 'knowledge_unresolved' && row.source_fingerprint === fingerprint)
      return unverified('已有记录表明资料不足，本次不重复联网；补充资料后会重新验证');
    await input.report?.(`Knowledge Gate：${decision.knowledgeNeed}，先验证本地资料。`);
    // A query mentioning time still needs freshness checks when source_required takes priority.
    const need = /最新|当前|现行|版本|\b(latest|current|version)\b/i.test(input.action.message) ? 'current' : decision.knowledgeNeed;
    const retrieve = () => searchKnowledgeBaseTool({userId:input.userId,goalId:input.goalId,purpose:'lesson_generation',knowledgeNeed:need,lessonScope:input.action.lessonScope},
      {query:decision.query || input.action.message,targetTopics:decision.targetTopics,mode:'auto',maxEvidenceTokens:2400});
    try { evidence = await retrieve(); }
    catch (error) { return serviceUnavailable(error); }
    if (evidence.status === 'sufficient') { saveGate(id,'resolved',evidence,fingerprint); return evidence; }
    if (decision.knowledgeNeed === 'source_required' || /^(false|0|no|off)$/i.test(process.env.WORKFLOW_AUTO_WEB || 'true')) {
      if(!strict) return unverified('本地资料不足且自动联网已关闭');
      saveGate(id,'waiting_for_sources',evidence,fingerprint);
      throw new SourceSelectionRequired('waiting_for_sources：指定范围内证据不足，请补充指定教材；不会自动替换教材。');
    }
    const operation = randomUUID(); // Fresh user action, never a lifetime quota.
    const visited = new Set<string>();
    let latestFingerprint = fingerprint;
    let lastFailure = '';
    for(let round=1;round<=3;round++) {
      const report = async (message:string) => input.report?.(`知识补充 ${round}/3 · ${message}`);
      const missing = evidence.missingTopics?.filter(t=>t.trim()) || [];
      const gaps = (missing.length ? missing : decision.targetTopics?.length ? decision.targetTopics : [decision.query || input.action.message]).join('；');
      const query = `${gaps.slice(0,350)}。寻找直接解释这些知识的正文和示例，不要书单、仓库首页、目录或文件下载。`;
      await report(`正在搜索；待补知识：${gaps}`);
      let imported=0;
      try {
        const result = await runWebResearch({userId:input.userId,goalId:input.goalId,query,automatic:true,
          workflowKey:`web-research:knowledge-gate:${id}:${operation}:${round}`,knowledgeGateId:id});
        if ('error' in result && result.error) throw new Error(result.error);
        const candidates = ('candidates' in result ? result.candidates || [] : []).filter(c=>!visited.has(c.url)).slice(0,3);
        await report(`找到 ${candidates.length} 个未处理正文候选；自动获取相关知识，不下载整套教材。`);
        for(const [index,candidate] of candidates.entries()) {
          visited.add(candidate.url);
          await report(`正文 ${index+1}/${candidates.length}：${candidate.title}（${candidate.url}）`);
          try {
            const saved = await ingestWebTool({userId:input.userId,goalId:input.goalId,trigger:'agent',
              onProgress:message=>report(`${candidate.title}：${message}`)},candidate.id,gaps,true);
            imported++;
            await report(`${candidate.title}：${saved.message}`);
          } catch(error) {
            lastFailure=error instanceof Error ? error.message : '正文处理失败';
            await report(`${candidate.title}：失败，${lastFailure}；继续其他来源。`);
          }
        }
      } catch(error) {
        lastFailure=error instanceof Error ? error.message : '搜索失败';
        await report(`搜索失败：${lastFailure}`);
      }
      await report(`本轮成功收录 ${imported} 项，正在重新 RAG 检索，由 LLM 判断知识是否足够、还缺什么，以及是否需要继续抓取。`);
      try { evidence = await retrieve(); }
      catch (error) { return serviceUnavailable(error); }
      const updated = resolveGoalSources(input.userId,input.goalId);
      latestFingerprint=createHash('sha256').update(JSON.stringify([ingestionPolicy,updated.mode,updated.sources.map(s=>[s.id,s.currentVersionId,s.activeChunkSetId,s.status]).sort()])).digest('hex');
      if(evidence.status==='sufficient') {
        saveGate(id,'resolved',evidence,latestFingerprint);
        await report('证据已充分，提前结束补充，继续生成教学内容。');
        return evidence;
      }
      await report(`验证仍不足：${evidence.missingTopics?.join('、') || evidence.insufficiencyReason}；${round<3?'进入下一轮，只补剩余缺口。':'已达到三轮上限，停止自动联网。'}`);
    }
    return unverified(`knowledge_unresolved：三轮补充后证据仍不足：${evidence.missingTopics?.join('、') || evidence.insufficiencyReason}。${lastFailure ? `最近处理失败：${lastFailure}。` : ''}`,latestFingerprint);
  }
}
