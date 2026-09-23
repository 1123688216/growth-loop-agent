type Evidence = { status: "sufficient" | "insufficient"; insufficiencyReason: string };
export class SourceSelectionRequired extends Error {
  readonly code = "source_selection_required";
}

/** A bounded supplement, not a retry of course generation. Search failures never trigger it. */
export async function resolveLessonEvidence<T extends Evidence>(input: {
  autoWeb: boolean;
  workflowConfigured: boolean;
  search: () => Promise<T>;
  supplement: (evidence: T) => Promise<{ error?: string; message?: string; status?: string }>;
  report: (message: string) => Promise<void>;
}): Promise<T> {
  await input.report("优先检索本节目标范围内已入库的资料（含此前收录网页）。");
  let evidence = await input.search();
  if (evidence.status === "sufficient") {
    await input.report("本地资料已通过 LLM 教学相关性与覆盖审核，无需联网；将使用通过审核的片段生成本节。");
    return evidence;
  }
  if (!input.autoWeb) {
    await input.report("本地资料不足，自动联网已关闭；按当前资料要求处理。");
    return evidence;
  }
  if (!input.workflowConfigured) throw new Error("本节资料不足，需要联网补充，但尚未配置 WORKFLOW_SERVICE_URL。请启动并配置 Workflow 服务后重试。");
  const reasons: Record<string, string> = {
    no_ready_sources: "没有可用资料", no_matching_evidence: "没有匹配内容",
    insufficient_lesson_evidence: "匹配证据数量或长度不足",
  };
  await input.report(`本地资料不足（${reasons[evidence.insufficiencyReason] || evidence.insufficiencyReason}），正在搜索候选摘要，等待你选择后才处理正文。`);
  const result = await input.supplement(evidence);
  if (result.error) throw new Error(`本节联网补充失败：${result.error}。请检查服务或手动补充资料后重试。`);
  if (result.status === "needs_selection") throw new SourceSelectionRequired(result.message || "请多选确认联网资料后继续课程生成。");
  await input.report(`${result.message || "联网补充流程已结束。"} 正在重新检索目标资料库。`);
  evidence = await input.search();
  if (evidence.status !== "sufficient") throw new Error(`source_insufficient：联网补充后本节资料仍不足（${evidence.insufficiencyReason}）。请手动补充资料后重试，不会使用无依据模板。`);
  await input.report("已联网补充并重新检索，资料通过 LLM 教学相关性与覆盖审核，继续生成本节。");
  return evidence;
}
