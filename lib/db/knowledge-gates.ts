import { createHash } from 'node:crypto';
import { getDatabase } from './index.ts';
import type { TutorKnowledgeDecision } from '../knowledge/knowledge-gate.ts';

export type GateRow = { id:string; status:string; rag_count:number; web_count:number; page_count:number; decision_json:string; evidence_json:string; source_fingerprint:string };
export function gateIdentity(userId:string,goalId:string,actionKey:string) {
  return createHash('sha256').update(JSON.stringify(['knowledge-gate-v1',userId,goalId,actionKey])).digest('hex');
}
export function readGate(id:string): GateRow | undefined {
  return getDatabase().prepare('SELECT * FROM knowledge_gates WHERE id=?').get(id) as GateRow | undefined;
}
export function createGate(id:string,userId:string,goalId:string,decision:TutorKnowledgeDecision) {
  getDatabase().prepare('INSERT OR IGNORE INTO knowledge_gates(id,user_id,goal_id,decision_json,updated_at) VALUES(?,?,?,?,?)')
    .run(id,userId,goalId,JSON.stringify(decision),new Date().toISOString());
  return readGate(id)!;
}
export function saveGate(id:string,status:string,evidence:unknown,fingerprint:string) {
  getDatabase().prepare('UPDATE knowledge_gates SET status=?,evidence_json=?,source_fingerprint=?,updated_at=? WHERE id=?')
    .run(status,JSON.stringify(evidence),fingerprint,new Date().toISOString(),id);
}
export function replaceGateDecision(id:string,decision:TutorKnowledgeDecision,actionFingerprint:string) {
  getDatabase().prepare("UPDATE knowledge_gates SET decision_json=?,status='pending',evidence_json='null',source_fingerprint='',updated_at=? WHERE id=?")
    .run(JSON.stringify({...decision,actionFingerprint}),new Date().toISOString(),id);
  return readGate(id)!;
}
export function waitingGate(userId:string,goalId:string) {
  return getDatabase().prepare("SELECT * FROM knowledge_gates WHERE user_id=? AND goal_id=? AND status='waiting_for_sources' ORDER BY updated_at DESC LIMIT 1")
    .get(userId,goalId) as GateRow | undefined;
}
