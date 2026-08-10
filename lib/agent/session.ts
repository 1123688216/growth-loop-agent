import type { ParsedAction } from "./understanding";

export type AgentSession = {
  lastAction: ParsedAction;
  updatedAt: number;
};

type AgentGlobal = typeof globalThis & {
  __growthLoopAgentSessions?: Map<string, AgentSession>;
};

const globalState = globalThis as AgentGlobal;
const sessions = globalState.__growthLoopAgentSessions ?? new Map<string, AgentSession>();
globalState.__growthLoopAgentSessions = sessions;

export function getAgentSession(id: string) {
  return sessions.get(id);
}

export function saveAgentSession(id: string, lastAction: ParsedAction) {
  sessions.set(id, { lastAction, updatedAt: Date.now() });

  if (sessions.size > 100) {
    const oldest = [...sessions.entries()].sort(([, a], [, b]) => a.updatedAt - b.updatedAt)[0]?.[0];
    if (oldest) sessions.delete(oldest);
  }
}
