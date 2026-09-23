import type { GroundedTutorContext, LessonContentOutput, LessonQualityIssue } from "./types.ts";

/** IDs prove provenance, not semantic support. The independent reviewer checks support. */
export function checkLessonSources(content: LessonContentOutput, context: GroundedTutorContext): LessonQualityIssue[] {
  const allowed = new Set(context.sources.map((source) => source.chunkId));
  return content.blocks.flatMap((block) => {
    const ids = block.sourceChunkIds || [];
    if (ids.length && ids.every((id) => allowed.has(id))) return [];
    return [{
      code: ids.length ? "source_out_of_scope" : "source_missing",
      severity: "error" as const,
      blockIds: [block.id],
      message: ids.length ? "教学块引用了本次检索之外的资料。" : "教学块缺少资料依据。",
      repairInstruction: "仅从 groundedContext.sources 选择真正支持本块的 chunkId，写入 sourceChunkIds；证据不支持时不得编造引用。",
    }];
  });
}

export function attachLessonSources(content: LessonContentOutput, context: GroundedTutorContext): LessonContentOutput {
  const ids = new Set(content.blocks.flatMap((block) => block.sourceChunkIds || []));
  const sources = context.sources.filter((source) => ids.has(source.chunkId));
  return {
    ...content,
    retrievalRunId: context.retrievalRunId,
    sourceStatus: "unverified",
    sourceRefs: sources.map((source) => source.chunkId),
    // Full evidence stays server-side in RetrievalRun; only bounded excerpts reach the UI.
    sources: sources.map((source) => ({
      chunkId: source.chunkId, sourceTitle: source.sourceTitle, heading: source.heading,
      pageStart: source.pageStart, pageEnd: source.pageEnd,
      snapshotHash: source.snapshotHash, excerpt: source.excerpt.slice(0, 600),
    })),
  };
}
