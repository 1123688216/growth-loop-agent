import type { EmbeddingModelAlias } from "./embedding-profiles.ts";
import {
  searchGoalKnowledgeBase,
  type KnowledgeSearchMode,
  type KnowledgeSearchPurpose,
} from "../db/retrieval.ts";

export type SearchKnowledgeBaseToolContext = {
  userId: string;
  goalId: string;
  lessonId?: string | null;
  skillId?: string | null;
  purpose: KnowledgeSearchPurpose;
  /** Trusted workflow replay key; never accepted from the model or browser. */
  idempotencyKey?: string;
  knowledgeNeed?: 'verify' | 'current' | 'source_required';
  lessonScope?: {title:string;objective:string};
};

export type SearchKnowledgeBaseToolInput = {
  query: string;
  targetTopics?: string[];
  mode?: KnowledgeSearchMode;
  model?: EmbeddingModelAlias;
  topK?: number;
  maxEvidenceTokens?: number;
};

/**
 * Agent-visible input intentionally excludes userId and arbitrary source ids.
 * The application injects ownership, goal, lesson and purpose from trusted workflow context.
 */
export function searchKnowledgeBaseTool(
  context: SearchKnowledgeBaseToolContext,
  input: SearchKnowledgeBaseToolInput,
) {
  return searchGoalKnowledgeBase({ query: input.query, targetTopics: input.targetTopics, mode: input.mode,
    model: input.model, topK: input.topK, maxEvidenceTokens: input.maxEvidenceTokens,
    ...context });
}
