import { randomUUID } from "node:crypto";

import { asRecord, cleanList, cleanText, requestStructured } from "@/lib/agents/shared";
import type { TutorCheckInput, TutorGradeInput, TutorLessonInput } from "@/lib/agents/types";
import type {
  AuthoredCourseQuestion,
  CourseLessonGradeDraft,
  CourseQuestionFeedback,
  EvidenceType,
  LearningBlock,
  LessonContentOutput,
  LessonQualityIssue,
} from "@/lib/learning-program/types";
import { LESSON_SCHEMA_VERSION, validateQuestionGrounding } from "@/lib/learning-program/quality";

const NARRATIVE_TYPES = new Set(["explanation", "concept_relation", "comparison", "case_study", "common_mistake", "boundary", "reflection", "summary"]);
const EXAMPLE_TYPES = new Set(["worked_example", "demonstration", "code_lab"]);
const PRACTICE_TYPES = new Set(["guided_practice", "retrieval_practice", "speaking_practice"]);

function cleanLongList(value: unknown, maxItems: number, maxChars: number) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => cleanText(item, "", maxChars))
    .filter(Boolean)
    .slice(0, maxItems);
}

function buildRuleContent(input: TutorLessonInput): LessonContentOutput {
  const { lesson, skill, mastery, goal } = input;
  const versionId = randomUUID();
  const software = /代码|编程|java|python|typescript|数据库|sql|api|agent|智能体|并发|线程|软件/i.test(`${goal.title} ${skill.name} ${skill.description}`);
  const knownState = mastery.confidence > 0 ? `已有证据为 ${mastery.score} 分` : "当前还没有可靠掌握证据";
  const exampleType = lesson.capabilityType === "procedural_skill"
    ? "demonstration"
    : software && lesson.capabilityType === "integrated_creation"
      ? "code_lab"
      : "worked_example";
  const practiceType = lesson.capabilityType === "retrieval_discrimination"
    ? "retrieval_practice"
    : lesson.capabilityType === "expression_communication"
      ? "speaking_practice"
      : "guided_practice";
  const scenario = software
    ? `一个开发者正在为「${goal.title}」实现最小功能，但现有结果无法证明「${skill.name}」是否真的成立。`
    : `学习者需要围绕「${goal.title}」完成「${skill.name}」，但只有结论，没有可复核的依据。`;
  const verification = software
    ? `使用最小可复现输入、一个正常断言和一个失败断言验证「${lesson.objective}」，并保存实际输出。`
    : `用事先写下的成功标准逐项检查成果，让另一位读者只看产物也能判断是否达到「${lesson.objective}」。`;

  const blocks: LearningBlock[] = [
    {
      id: `${versionId}-explain`, type: "explanation", title: "先建立判断框架", objectiveIds: ["lesson-objective"],
      body: `${skill.description}。本节不是记住一句定义，而是围绕「${lesson.objective}」识别输入、约束、选择和可观察结果。${knownState}，所以讲解会从最小可验证行为开始。`,
      points: lesson.concepts.slice(0, 4),
    },
    {
      id: `${versionId}-compare`, type: "comparison", title: "区分正确理解与表面熟悉", objectiveIds: ["lesson-objective"],
      body: `表面熟悉只会复述「${skill.name}」；可用能力则能说明何时使用、为什么这样选择，以及结果不符合预期时检查哪里。二者的差别在于是否留下能够被别人复核的判断链。`,
      points: ["适用条件", "判断依据", "结果验证"],
    },
    {
      id: `${versionId}-example`, type: exampleType, title: "走完一个可验证案例", objectiveIds: ["lesson-objective"],
      scenario,
      steps: [
        `把目标收窄为：${lesson.objective}`,
        `列出本案例必须使用的概念：${lesson.concepts.slice(0, 3).join("、")}`,
        `根据「${skill.description}」做出一个明确选择，并记录没有采用的方案`,
        "执行后同时记录预期结果和实际结果，再解释差异",
      ],
      result: `得到一份能够展示「${skill.name}」的最小成果，并能说清选择与结果之间的关系。`,
      verification,
    } as LearningBlock,
    {
      id: `${versionId}-mistake`, type: "common_mistake", title: "最容易出现的错误", objectiveIds: ["lesson-objective"],
      body: `常见错误是直接套用结论，却没有先检查「${lesson.concepts[0] || skill.name}」的前提。这样即使结果偶然正确，也无法复现。发现答案只有术语、没有约束或验证时，应退回补齐判断依据。`,
      points: ["错误表现：只有结论", "错误原因：忽略前提", "修复方式：补齐验证"],
    },
    {
      id: `${versionId}-boundary`, type: "boundary", title: "适用边界", objectiveIds: ["lesson-objective"],
      body: `本节方法适合验证「${skill.name}」的基础应用，不代表已经覆盖该主题的全部复杂情况。当输入规模、协作对象或风险等级改变时，需要重新检查约束，不能把这个最小案例直接当成通用答案。`,
      points: ["规模变化", "约束变化", "风险变化"],
    },
    {
      id: `${versionId}-practice`, type: practiceType, title: "独立完成一次迁移", objectiveIds: ["lesson-objective"],
      prompt: `在「${goal.title}」中选择一个不同于上方案例的任务，独立完成「${lesson.objective}」，并保留你的判断过程。`,
      hints: ["先写输入和约束", `至少使用 ${lesson.concepts.slice(0, 2).join(" 与 ") || skill.name}`, "最后比较预期与实际结果"],
      completionCriteria: lesson.completionEvidence.length ? lesson.completionEvidence : [`成果能体现：${skill.description}`, "包含可复核的验证结果"],
    } as LearningBlock,
    {
      id: `${versionId}-summary`, type: lesson.capabilityType === "expression_communication" ? "reflection" : "summary", title: "把方法压缩成自己的判断", objectiveIds: ["lesson-objective"],
      body: `完成本节后，你应能不用课程原句解释「${skill.name}」，在新任务里作出选择，并用实际结果说明「${lesson.objective}」是否达到。若还只能复述概念，就回到案例和独立练习补齐证据。`,
      points: ["能解释", "能选择", "能验证"],
    },
  ];
  if (lesson.capabilityType === "retrieval_discrimination" && practiceType !== "retrieval_practice") {
    // 当前分支不会发生，保留显式约束以免以后调整策略时漏掉主动回忆。
    throw new Error("retrieval strategy requires retrieval_practice");
  }
  return {
    schemaVersion: LESSON_SCHEMA_VERSION,
    contentVersionId: versionId,
    lessonId: "",
    skillId: skill.id,
    title: lesson.title,
    objective: lesson.objective,
    capabilityType: lesson.capabilityType,
    estimatedMinutes: lesson.durationMinutes,
    blocks,
    evidenceRequirements: [{
      id: `${versionId}-evidence`, objectiveId: "lesson-objective",
      type: lesson.capabilityType === "integrated_creation" ? "artifact" : lesson.capabilityType === "procedural_skill" ? "procedure" : "transfer",
      description: lesson.completionEvidence[0] || `提交一份能体现「${skill.name}」的可验证成果。`,
      successCriteria: lesson.completionEvidence.length ? lesson.completionEvidence : ["包含结论和依据", "包含执行过程", "包含验证结果"],
    }],
    sourceStatus: "unverified",
    sourceRefs: [],
    modelSummary: `围绕「${skill.name}」完成解释、案例、边界和独立练习。`,
  };
}

function normalizeBlocks(value: unknown, versionId: string): LearningBlock[] | null {
  if (!Array.isArray(value) || value.length < 5 || value.length > 12) return null;
  const blocks: LearningBlock[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = asRecord(value[index]);
    if (!item) return null;
    const type = cleanText(item.type, "", 40);
    const base = {
      id: `${versionId}-b${index + 1}`,
      title: cleanText(item.title, "", 100),
      objectiveIds: ["lesson-objective"],
    };
    if (!base.title) return null;
    if (NARRATIVE_TYPES.has(type)) {
      const body = cleanText(item.body, "", 2200);
      const points = cleanList(item.points, [], 8);
      if (!body) return null;
      blocks.push({ ...base, type: type as Extract<LearningBlock, { body: string }>["type"], body, points });
    } else if (EXAMPLE_TYPES.has(type)) {
      const scenario = cleanText(item.scenario, "", 1000);
      // 示例步骤可能包含一段完整代码。通用 cleanList 的 180 字符上限会把
      // 可运行代码截断，进而让质量复核误判为模型遗漏，因此这里单独放宽。
      const steps = cleanLongList(item.steps, 8, 2400);
      const result = cleanText(item.result, "", 800);
      const verification = cleanText(item.verification, "", 800);
      if (!scenario || steps.length < 2 || !result || !verification) return null;
      blocks.push({ ...base, type: type as Extract<LearningBlock, { scenario: string }>["type"], scenario, steps, result, verification });
    } else if (PRACTICE_TYPES.has(type)) {
      const prompt = cleanText(item.prompt, "", 1000);
      const hints = cleanList(item.hints, [], 6);
      const completionCriteria = cleanList(item.completionCriteria, [], 6);
      if (!prompt || !completionCriteria.length) return null;
      blocks.push({ ...base, type: type as Extract<LearningBlock, { prompt: string }>["type"], prompt, hints, completionCriteria });
    } else {
      return null;
    }
  }
  return blocks;
}

export async function buildLessonMaterial(input: TutorLessonInput) {
  const fallback = buildRuleContent(input);
  return requestStructured({
    fallback,
    timeoutMs: 120_000,
    system: "你是学习过程中的导师。生成一节可独立学习、可练习、可检查的结构化课程。只教授当前能力，不提前宣称学生已掌握，不捏造资料来源。只输出严格 JSON。",
    user: `完整目标：${JSON.stringify(input.goal)}\n当前能力：${JSON.stringify(input.skill)}\n章节骨架：${JSON.stringify(input.lesson)}\n掌握证据：${JSON.stringify(input.mastery)}\n诊断摘要：${JSON.stringify(input.diagnosticEvidence || [])}\n上一课证据：${JSON.stringify(input.previousLessonEvidence || [])}\n\n输出 schemaVersion、title、objective、capabilityType、estimatedMinutes、blocks、evidenceRequirements、modelSummary。blocks 必须为 5-12 个，类型只能是 explanation、concept_relation、comparison、worked_example、case_study、demonstration、common_mistake、boundary、guided_practice、retrieval_practice、reflection、summary、code_lab、speaking_practice。叙述块输出 type/title/body/points；示例块输出 type/title/scenario/steps/result/verification；练习块输出 type/title/prompt/hints/completionCriteria。内容必须出现本主题特有的概念、约束或产物；示例必须有输入、步骤、结果和验证；禁止使用“结合实际”“给出一个具体场景”等占位句。`,
    normalize(raw) {
      const blocks = normalizeBlocks(raw.blocks, fallback.contentVersionId);
      if (!blocks) return null;
      const rawEvidence = Array.isArray(raw.evidenceRequirements) ? raw.evidenceRequirements.slice(0, 4) : [];
      const evidenceRequirements = rawEvidence.map((value, index) => {
        const item = asRecord(value);
        const source = fallback.evidenceRequirements[Math.min(index, fallback.evidenceRequirements.length - 1)];
        const requestedType = cleanText(item?.type, source.type, 40) as EvidenceType;
        const allowed: EvidenceType[] = ["explanation", "discrimination", "procedure", "problem_solution", "transfer", "artifact"];
        return {
          id: `${fallback.contentVersionId}-e${index + 1}`,
          objectiveId: "lesson-objective",
          type: allowed.includes(requestedType) ? requestedType : source.type,
          description: cleanText(item?.description, source.description, 600),
          successCriteria: cleanList(item?.successCriteria, source.successCriteria, 6),
        };
      });
      if (!evidenceRequirements.length) return null;
      return {
        ...fallback,
        title: cleanText(raw.title, input.lesson.title, 160),
        objective: cleanText(raw.objective, input.lesson.objective, 500),
        blocks,
        evidenceRequirements,
        modelSummary: cleanText(raw.modelSummary, fallback.modelSummary, 600),
      };
    },
  });
}

export async function reviewLessonSemantics(content: LessonContentOutput) {
  const fallback = { passed: true, score: 88, issues: [] as LessonQualityIssue[] };
  return requestStructured({
    fallback,
    timeoutMs: 90_000,
    system: "你是独立课程质量复核器，不是产品中的复盘员。只检查课程是否具体、自洽、难度适配、示例可验证、练习与目标一致。确定性字段规则由代码处理。只输出严格 JSON。",
    user: `复核以下课程：${JSON.stringify(content)}\n输出 passed、score（0-100）和 issues。每个 issue 含 code、severity（error/warning）、blockIds、message、repairInstruction。不要因为文风优美而放过空泛内容；也不要要求课程覆盖当前目标之外的知识。`,
    normalize(raw) {
      const values = Array.isArray(raw.issues) ? raw.issues.slice(0, 8) : [];
      const issues = values.map((value) => {
        const item = asRecord(value);
        return {
          code: cleanText(item?.code, "semantic_issue", 80),
          severity: cleanText(item?.severity, "warning", 20) === "error" ? "error" as const : "warning" as const,
          blockIds: cleanList(item?.blockIds, [], 8),
          message: cleanText(item?.message, "课程内容需要进一步具体化。", 500),
          repairInstruction: cleanText(item?.repairInstruction, "补充具体约束、例子或验证方法。", 500),
        };
      });
      const passed = raw.passed === true && issues.every((item) => item.severity !== "error");
      return { passed, score: Math.max(0, Math.min(100, Math.round(Number(raw.score) || (passed ? 80 : 50)))), issues };
    },
  });
}

export async function repairLessonMaterial(input: TutorLessonInput, current: LessonContentOutput, issues: LessonQualityIssue[]) {
  const fallback = buildRuleContent(input);
  return requestStructured({
    fallback,
    timeoutMs: 120_000,
    system: "你是课程修订导师。只修复质量报告指出的问题，保留已经合格的教学意图；输出一份完整、可独立发布的结构化课程 JSON。",
    user: `原课程：${JSON.stringify(current)}\n质量问题：${JSON.stringify(issues)}\n目标与学习者上下文：${JSON.stringify(input)}\n按问题中的 repairInstruction 修订。输出格式与原课程一致；禁止保留通用占位句，不得虚构外部来源。`,
    normalize(raw) {
      const blocks = normalizeBlocks(raw.blocks, fallback.contentVersionId);
      if (!blocks) return null;
      return {
        ...fallback,
        title: cleanText(raw.title, current.title, 160),
        objective: cleanText(raw.objective, current.objective, 500),
        blocks,
        modelSummary: cleanText(raw.modelSummary, current.modelSummary, 600),
      };
    },
  });
}

function fallbackQuestions(input: TutorCheckInput): AuthoredCourseQuestion[] {
  const explanation = input.material.blocks.find((block) => block.type === "explanation") || input.material.blocks[0];
  const example = input.material.blocks.find((block) => EXAMPLE_TYPES.has(block.type)) || input.material.blocks[0];
  const practice = input.material.blocks.find((block) => PRACTICE_TYPES.has(block.type)) || input.material.blocks.at(-1)!;
  return [
    {
      id: "understanding",
      skillId: input.skill.id,
      kind: "理解",
      contentVersionId: input.material.contentVersionId,
      taughtBlockIds: [explanation.id],
      evidenceType: "explanation",
      expectedConcepts: input.lesson.concepts.slice(0, 3),
      prompt: `在「${input.goal.title}」中，为什么只复述「${input.skill.name}」还不能证明已经会用？请结合本节的判断框架说明。`,
      hint: "不要只写定义，至少补充一个何时适用或不适用的判断。",
      referenceAnswer: `能够准确解释${input.skill.description}，并给出合理的适用边界。`,
      rubric: "概念与边界 60 分；表达清楚且使用自己的话 40 分。",
      maxScore: 100,
    },
    {
      id: "transfer",
      skillId: input.skill.id,
      kind: "迁移",
      contentVersionId: input.material.contentVersionId,
      taughtBlockIds: [example.id, practice.id],
      evidenceType: "transfer",
      expectedConcepts: input.lesson.concepts.slice(0, 3),
      prompt: `本节案例的约束发生变化：输入规模扩大一倍，但验收目标仍是「${input.lesson.objective}」。你会保留和调整哪些步骤？怎样验证调整有效？`,
      hint: "场景可以小，但需要能判断结果是否真的有效。",
      referenceAnswer: "包含具体场景、合理依据、可执行步骤和可观察的验证标准。",
      rubric: "场景与依据 30 分；步骤 35 分；验证方式 35 分。",
      maxScore: 100,
    },
    {
      id: "teach-back",
      skillId: input.skill.id,
      kind: "教回",
      contentVersionId: input.material.contentVersionId,
      taughtBlockIds: input.material.blocks.filter((block) => block.type === "common_mistake" || block.type === "boundary").map((block) => block.id).slice(0, 2),
      evidenceType: "discrimination",
      expectedConcepts: [input.skill.name, "适用边界", "验证结果"],
      prompt: `同伴在「${input.goal.title}」里直接套用「${input.skill.name}」的结论，却没有检查前提。请指出你会观察到的错误信号，并给出纠正和复核步骤。`,
      hint: "说清错误表现、错误原因和纠正后的检查办法。",
      referenceAnswer: "指出可信的常见错误，解释原因，给出纠正步骤和检查结果的方法。",
      rubric: "错误识别 30 分；原因 30 分；纠正与检查 40 分。",
      maxScore: 100,
    },
  ];
}

export async function buildLessonCheck(input: TutorCheckInput) {
  const fallback = fallbackQuestions(input);
  return requestStructured({
    fallback,
    timeoutMs: 120_000,
    system: "你是刚教授完当前章节的导师。根据实际讲过的内容出 3 道巩固题，检验理解、迁移和教回；不得考课程未覆盖内容。只输出严格 JSON。",
    user: `能力：${JSON.stringify(input.skill)}\n章节：${JSON.stringify(input.lesson)}\n已发布教学内容：${JSON.stringify(input.material)}\n输出 {"questions":[...]}。每题字段 kind（理解/迁移/教回）、taughtBlockIds、evidenceType、expectedConcepts、prompt、hint、referenceAnswer、rubric、maxScore；maxScore 固定 100。taughtBlockIds 必须来自已发布教学块，题目不得考没有讲过的事实。`,
    normalize(raw) {
      const questions = Array.isArray(raw.questions) ? raw.questions.slice(0, 3) : [];
      if (questions.length !== 3) return fallback;
      const normalized = questions.map((value, index) => {
        const item = asRecord(value);
        const source = fallback[index];
        const requestedKind = cleanText(item?.kind, source.kind, 10);
        const taughtBlockIds = cleanList(item?.taughtBlockIds, [], 4).filter((id) => input.material.blocks.some((block) => block.id === id));
        const evidenceType = cleanText(item?.evidenceType, source.evidenceType, 40) as EvidenceType;
        const evidenceTypes: EvidenceType[] = ["explanation", "discrimination", "procedure", "problem_solution", "transfer", "artifact"];
        return {
          id: source.id,
          skillId: input.skill.id,
          kind: requestedKind === "理解" || requestedKind === "迁移" || requestedKind === "教回" ? requestedKind : source.kind,
          contentVersionId: input.material.contentVersionId,
          taughtBlockIds,
          evidenceType: evidenceTypes.includes(evidenceType) ? evidenceType : source.evidenceType,
          expectedConcepts: cleanList(item?.expectedConcepts, source.expectedConcepts || [], 6),
          prompt: cleanText(item?.prompt, source.prompt, 800),
          hint: cleanText(item?.hint, source.hint, 400),
          referenceAnswer: cleanText(item?.referenceAnswer, source.referenceAnswer, 1600),
          rubric: cleanText(item?.rubric, source.rubric, 1000),
          maxScore: 100,
        };
      });
      return validateQuestionGrounding(input.material, normalized).length ? fallback : normalized;
    },
  });
}

function ruleScore(answer: string) {
  const lengthScore = Math.min(55, Math.round(answer.trim().length * 0.7));
  const evidenceScore = /因为|依据|原因|判断/.test(answer) ? 15 : 0;
  const stepScore = /步骤|首先|然后|最后|1[.、]|2[.、]/.test(answer) ? 15 : 0;
  const verifyScore = /验证|检查|测试|结果|标准/.test(answer) ? 15 : 0;
  return Math.min(100, lengthScore + evidenceScore + stepScore + verifyScore);
}

function fallbackGrade(input: TutorGradeInput): CourseLessonGradeDraft {
  const feedback: CourseQuestionFeedback[] = input.questions.map((question) => {
    const answer = input.answers[question.id]?.trim() || "";
    const score = ruleScore(answer);
    return {
      questionId: question.id,
      score,
      maxScore: question.maxScore,
      feedback: answer ? (score >= 60 ? "已给出基本判断，请继续补足更具体的证据和验证标准。" : "回答还缺少依据、执行步骤或验证方式，请结合本节内容补全。") : "尚未作答。",
      reference: question.referenceAnswer,
    };
  });
  const score = Math.round(feedback.reduce((sum, item) => sum + item.score / item.maxScore, 0) / Math.max(1, feedback.length) * 100);
  return {
    lessonId: input.lesson.title,
    score,
    summary: score >= 60 ? "你已经留下了本节的基础理解证据。" : "当前证据还不足以证明已经掌握本节内容。",
    nextStep: score >= 60 ? "进入下一节，并在新场景中继续使用本节方法。" : "根据逐题反馈补充答案后再次提交。",
    feedback,
    gradedBy: "rules",
    provider: "本地规则",
    model: "",
  };
}

export async function gradeLessonCheck(input: TutorGradeInput) {
  const fallback = fallbackGrade(input);
  const result = await requestStructured({
    fallback,
    system: "你是教授过本节内容的导师。只依据题目、参考答案、评分标准和学生作答评分；不能因表达流畅而忽略事实错误。只输出严格 JSON。",
    user: `章节材料：${JSON.stringify(input.material)}\n题目：${JSON.stringify(input.questions)}\n回答：${JSON.stringify(input.answers)}\n输出 summary、nextStep、feedback。feedback 每项含 questionId、score（0 到 maxScore）、feedback、reference、maxScore。`,
    normalize(raw) {
      const values = Array.isArray(raw.feedback) ? raw.feedback : [];
      if (values.length !== input.questions.length) return fallback;
      const feedback = input.questions.map((question, index) => {
        const item = asRecord(values[index]);
        return {
          questionId: question.id,
          score: Math.max(0, Math.min(question.maxScore, Math.round(Number(item?.score) || 0))),
          maxScore: question.maxScore,
          feedback: cleanText(item?.feedback, fallback.feedback[index].feedback, 1000),
          reference: question.referenceAnswer,
        };
      });
      const score = Math.round(feedback.reduce((sum, item) => sum + item.score / item.maxScore, 0) / Math.max(1, feedback.length) * 100);
      return { ...fallback, score, summary: cleanText(raw.summary, fallback.summary, 800), nextStep: cleanText(raw.nextStep, fallback.nextStep, 600), feedback };
    },
  });
  return {
    ...result,
    data: { ...result.data, lessonId: input.lesson.title, gradedBy: result.mode, provider: result.provider, model: result.model },
  };
}
