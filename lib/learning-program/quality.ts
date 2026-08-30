import type {
  AuthoredCourseQuestion,
  CapabilityType,
  LearningBlock,
  LessonContentOutput,
  LessonQualityIssue,
  LessonQualityReport,
} from "@/lib/learning-program/types";

export const LESSON_SCHEMA_VERSION = "1" as const;
export const LESSON_QUALITY_CHECKER_VERSION = "v0.4.3-rules-1";
export const LESSON_PROMPT_VERSION = "v0.4.3-tutor-1";
export const MAX_LESSON_REPAIR_ATTEMPTS = 2;

const GENERIC_PATTERNS = [
  /请给出一个具体场景/,
  /结合实际(进行|完成|说明)?/,
  /根据实际情况/,
  /写清目标、?判断依据、?执行步骤和验证结果/,
  /选择一个与.+有关的真实场景/,
  /能够帮助你更好地理解/,
  /在日常生活和工作中/,
];

const REQUIRED_BLOCKS: Record<CapabilityType, Array<LearningBlock["type"][]>> = {
  conceptual_understanding: [
    ["explanation"],
    ["concept_relation", "comparison"],
    ["worked_example", "case_study"],
    ["common_mistake", "boundary"],
    ["retrieval_practice", "guided_practice"],
  ],
  procedural_skill: [
    ["demonstration", "code_lab"],
    ["guided_practice"],
    ["common_mistake", "boundary"],
  ],
  problem_solving: [
    ["worked_example", "case_study", "code_lab"],
    ["guided_practice"],
    ["common_mistake", "boundary"],
  ],
  expression_communication: [
    ["worked_example", "case_study"],
    ["guided_practice", "speaking_practice"],
    ["reflection", "summary"],
  ],
  retrieval_discrimination: [
    ["comparison", "concept_relation"],
    ["retrieval_practice"],
    ["common_mistake", "boundary"],
  ],
  integrated_creation: [
    ["worked_example", "case_study", "demonstration", "code_lab"],
    ["guided_practice"],
    ["summary", "reflection"],
  ],
};

function blockText(block: LearningBlock) {
  if ("body" in block) return [block.title, block.body, ...block.points].join(" ");
  if ("scenario" in block) return [block.title, block.scenario, ...block.steps, block.result, block.verification].join(" ");
  return [block.title, block.prompt, ...block.hints, ...block.completionCriteria].join(" ");
}

function issue(
  code: string,
  message: string,
  repairInstruction: string,
  blockIds: string[] = [],
  severity: LessonQualityIssue["severity"] = "error",
): LessonQualityIssue {
  return { code, severity, blockIds, message, repairInstruction };
}

/** 只有代码可确定的规则才能进入硬门禁；LLM 复核不得推翻这里的错误。 */
export function runDeterministicLessonGate(content: LessonContentOutput): LessonQualityIssue[] {
  const issues: LessonQualityIssue[] = [];
  const ids = content.blocks.map((block) => block.id);
  const uniqueIds = new Set(ids);
  if (ids.length !== uniqueIds.size) {
    issues.push(issue("duplicate_block_id", "教学块 ID 不唯一。", "为每个教学块分配唯一且稳定的 ID。"));
  }
  if (content.blocks.length < 5) {
    issues.push(issue("insufficient_blocks", "教学块不足，无法形成讲解—示例—练习闭环。", "至少补齐解释、具体例子、误区或边界、练习和总结。"));
  }
  if (!content.blocks.some((block) => block.objectiveIds.includes("lesson-objective"))) {
    issues.push(issue("objective_uncovered", "本节目标没有被任何教学块覆盖。", "将至少一个教学块明确绑定到 lesson-objective。"));
  }

  const types = new Set(content.blocks.map((block) => block.type));
  for (const alternatives of REQUIRED_BLOCKS[content.capabilityType]) {
    if (!alternatives.some((type) => types.has(type))) {
      issues.push(issue(
        `missing_${alternatives.join("_or_")}`,
        `缺少 ${alternatives.join(" / ")} 教学块。`,
        `按 ${content.capabilityType} 的教学策略补充 ${alternatives.join(" 或 ")}。`,
      ));
    }
  }

  const exampleBlocks = content.blocks.filter((block) => ["worked_example", "case_study", "demonstration", "code_lab"].includes(block.type));
  if (!exampleBlocks.length) {
    issues.push(issue("missing_concrete_example", "没有可执行或可验证的具体例子。", "增加带输入、步骤、结果和验证方式的完整例子。"));
  } else if (exampleBlocks.every((block) => blockText(block).length < 90)) {
    issues.push(issue("thin_example", "示例信息不足，无法支撑迁移。", "为示例补充约束、推理步骤、结果和验证方法。", exampleBlocks.map((block) => block.id)));
  }

  if (!types.has("common_mistake") && !types.has("boundary")) {
    issues.push(issue("missing_boundary", "课程没有说明常见错误或适用边界。", "增加错误表现、原因、诊断和修复，或说明不适用情形。"));
  }

  const practiceBlocks = content.blocks.filter((block) => ["guided_practice", "retrieval_practice", "speaking_practice", "code_lab"].includes(block.type));
  if (!practiceBlocks.length) {
    issues.push(issue("missing_practice", "课程没有学习者需要独立完成的练习。", "增加有提示、完成标准和可观察结果的练习。"));
  }
  if (!content.evidenceRequirements.length) {
    issues.push(issue("missing_evidence", "课程没有定义完成证据。", "增加至少一个可检查的交付物或表现及成功标准。"));
  }

  const genericBlocks = content.blocks.filter((block) => GENERIC_PATTERNS.some((pattern) => pattern.test(blockText(block))));
  if (genericBlocks.length) {
    issues.push(issue(
      "generic_template",
      "课程仍包含未填充的通用模板表达。",
      "把占位场景替换成与本节能力和目标直接相关的具体数据、约束或产物。",
      genericBlocks.map((block) => block.id),
    ));
  }

  const emptyBlocks = content.blocks.filter((block) => blockText(block).trim().length < 35);
  if (emptyBlocks.length) {
    issues.push(issue("thin_block", "部分教学块过短，无法独立承担教学作用。", "补充因果解释、具体条件或检查方法。", emptyBlocks.map((block) => block.id)));
  }

  if (content.estimatedMinutes < 20 || content.estimatedMinutes > 120) {
    issues.push(issue("invalid_duration", "课程预计时长不在 20–120 分钟范围内。", "调整课时或拆分内容。"));
  } else if (content.blocks.length > Math.ceil(content.estimatedMinutes / 5) + 3) {
    issues.push(issue("duration_overloaded", "教学块数量明显超过课时时间能够承载的范围。", "删除次要内容或拆分为下一节。", [], "warning"));
  }

  const invalidRefs = content.blocks.filter((block) => !block.objectiveIds.length || block.objectiveIds.some((id) => id !== "lesson-objective"));
  if (invalidRefs.length) {
    issues.push(issue("invalid_objective_reference", "教学块引用了不存在的课程目标。", "当前版本只允许引用 lesson-objective。", invalidRefs.map((block) => block.id)));
  }

  return issues;
}

export function buildLessonQualityReport(input: {
  content: LessonContentOutput;
  semanticIssues?: LessonQualityIssue[];
  semanticPassed?: boolean;
  mode?: "llm" | "rules";
  provider?: string;
  model?: string;
}): LessonQualityReport {
  const deterministicIssues = runDeterministicLessonGate(input.content);
  const semanticIssues = input.semanticIssues || [];
  const issues = [...deterministicIssues, ...semanticIssues];
  const errors = issues.filter((item) => item.severity === "error").length;
  const warnings = issues.length - errors;
  return {
    deterministicPassed: deterministicIssues.every((item) => item.severity !== "error"),
    semanticPassed: input.semanticPassed ?? semanticIssues.every((item) => item.severity !== "error"),
    score: Math.max(0, 100 - errors * 12 - warnings * 4),
    issues,
    checkerVersion: LESSON_QUALITY_CHECKER_VERSION,
    checkedAt: new Date().toISOString(),
    mode: input.mode || "rules",
    provider: input.provider || "本地质量规则",
    model: input.model || "",
  };
}

export function qualityPassed(report: LessonQualityReport) {
  return report.deterministicPassed && report.semanticPassed && report.issues.every((item) => item.severity !== "error");
}

/** 兼容现有课程 UI 和答疑输入；新页面优先直接渲染 blocks。 */
export function projectLessonContent(content: LessonContentOutput) {
  const narrative = content.blocks.filter((block): block is Extract<LearningBlock, { body: string }> => "body" in block);
  const example = content.blocks.find((block): block is Extract<LearningBlock, { scenario: string }> => "scenario" in block);
  const practice = content.blocks.find((block): block is Extract<LearningBlock, { prompt: string }> => "prompt" in block);
  const explanation = narrative
    .filter((block) => ["explanation", "concept_relation", "comparison"].includes(block.type))
    .map((block) => `${block.title}：${block.body}${block.points.length ? ` ${block.points.join("；")}` : ""}`)
    .join("\n");
  return {
    opening: narrative[0]?.body || content.modelSummary,
    explanation: explanation || content.modelSummary,
    example: example
      ? `${example.scenario}\n${example.steps.map((step, index) => `${index + 1}. ${step}`).join("\n")}\n结果：${example.result}\n验证：${example.verification}`
      : "",
    practice: practice ? `${practice.prompt}\n完成标准：${practice.completionCriteria.join("；")}` : "",
    deliverable: content.evidenceRequirements[0]?.description || "完成本节可验证练习。",
    // concepts 是短概念名，用于列表页和出题时的 expectedConcepts。
    // 不能把叙述块的 points 摊平进来——那是整句，会和块正文重复渲染一遍。
    concepts: [...new Set(narrative.map((block) => block.title).filter(Boolean))].slice(0, 6),
  };
}

export function validateQuestionGrounding(content: LessonContentOutput, questions: AuthoredCourseQuestion[]) {
  const blockIds = new Set(content.blocks.map((block) => block.id));
  const issues: string[] = [];
  for (const question of questions) {
    if (question.contentVersionId !== content.contentVersionId) issues.push(`${question.id}:content_version_mismatch`);
    if (!question.taughtBlockIds?.length) issues.push(`${question.id}:missing_taught_blocks`);
    if (question.taughtBlockIds?.some((id) => !blockIds.has(id))) issues.push(`${question.id}:unknown_taught_block`);
    if (!question.expectedConcepts?.length) issues.push(`${question.id}:missing_expected_concepts`);
  }
  return issues;
}
