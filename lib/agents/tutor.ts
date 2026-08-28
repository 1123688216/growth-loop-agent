import { asRecord, cleanList, cleanText, requestStructured } from "@/lib/agents/shared";
import type { TutorCheckInput, TutorGradeInput, TutorLessonInput } from "@/lib/agents/types";
import type { AuthoredCourseQuestion, CourseLessonGradeDraft, CourseQuestionFeedback } from "@/lib/learning-program/types";

function fallbackMaterial(input: TutorLessonInput) {
  const { lesson, skill, mastery } = input;
  return {
    opening: `这一节聚焦「${lesson.title}」。先把它和你已经会的内容连起来，再完成一个可验证的小成果。`,
    explanation: `${skill.description}。学习时不要只记结论：先说明适用边界，再按步骤执行，最后用结果验证自己的判断。当前掌握度 ${mastery.confidence > 0 ? `${mastery.score} 分` : "尚无证据"}，因此本节会从可观察行为开始。`,
    example: `示例：选一个与「${input.goal.title}」有关的真实场景，写清目标、判断依据、执行步骤和验证结果。`,
    practice: `练习：不用照抄示例，用自己的场景完成一次「${skill.name}」应用，并记录哪里最不确定。`,
    deliverable: `提交一份能体现「${skill.name}」的短成果，至少包含结论、依据、步骤和验证方式。`,
    concepts: lesson.concepts,
  };
}

export async function buildLessonMaterial(input: TutorLessonInput) {
  const fallback = fallbackMaterial(input);
  return requestStructured({
    fallback,
    system: "你是学习过程中的导师。只教授当前章节和能力点，根据已有掌握证据调整讲解，不提前宣称学生已掌握。只输出严格 JSON。",
    user: `目标：${input.goal.title}\n当前能力：${input.skill.name}（${input.skill.description}）\n章节：${JSON.stringify(input.lesson)}\n掌握证据：${JSON.stringify(input.mastery)}\n输出 opening、explanation、example、practice、deliverable、concepts。讲解必须能支持随后出题，并要求可验证成果。`,
    normalize(raw) {
      return {
        opening: cleanText(raw.opening, fallback.opening, 800),
        explanation: cleanText(raw.explanation, fallback.explanation, 3500),
        example: cleanText(raw.example, fallback.example, 1800),
        practice: cleanText(raw.practice, fallback.practice, 1200),
        deliverable: cleanText(raw.deliverable, fallback.deliverable, 1000),
        concepts: cleanList(raw.concepts, fallback.concepts, 8),
      };
    },
  });
}

function fallbackQuestions(input: TutorCheckInput): AuthoredCourseQuestion[] {
  return [
    {
      id: "understanding",
      skillId: input.skill.id,
      kind: "理解",
      prompt: `请用自己的话解释「${input.skill.name}」，并说明它的适用边界。`,
      hint: "不要只写定义，至少补充一个何时适用或不适用的判断。",
      referenceAnswer: `能够准确解释${input.skill.description}，并给出合理的适用边界。`,
      rubric: "概念与边界 60 分；表达清楚且使用自己的话 40 分。",
      maxScore: 100,
    },
    {
      id: "transfer",
      skillId: input.skill.id,
      kind: "迁移",
      prompt: `把本节方法用于一个不同于示例的真实场景，写出依据、步骤和验证方式。`,
      hint: "场景可以小，但需要能判断结果是否真的有效。",
      referenceAnswer: "包含具体场景、合理依据、可执行步骤和可观察的验证标准。",
      rubric: "场景与依据 30 分；步骤 35 分；验证方式 35 分。",
      maxScore: 100,
    },
    {
      id: "teach-back",
      skillId: input.skill.id,
      kind: "教回",
      prompt: `假设同伴在学习「${input.skill.name}」时犯了一个常见错误，你会怎样发现并纠正？`,
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
    system: "你是刚教授完当前章节的导师。根据实际讲过的内容出 3 道巩固题，检验理解、迁移和教回；不得考课程未覆盖内容。只输出严格 JSON。",
    user: `能力：${JSON.stringify(input.skill)}\n章节：${JSON.stringify(input.lesson)}\n已讲内容：${JSON.stringify(input.material)}\n输出 {"questions":[...]}。每题字段 kind（理解/迁移/教回）、prompt、hint、referenceAnswer、rubric、maxScore；maxScore 固定 100。`,
    normalize(raw) {
      const questions = Array.isArray(raw.questions) ? raw.questions.slice(0, 3) : [];
      if (questions.length !== 3) return fallback;
      return questions.map((value, index) => {
        const item = asRecord(value);
        const source = fallback[index];
        const requestedKind = cleanText(item?.kind, source.kind, 10);
        return {
          id: source.id,
          skillId: input.skill.id,
          kind: requestedKind === "理解" || requestedKind === "迁移" || requestedKind === "教回" ? requestedKind : source.kind,
          prompt: cleanText(item?.prompt, source.prompt, 800),
          hint: cleanText(item?.hint, source.hint, 400),
          referenceAnswer: cleanText(item?.referenceAnswer, source.referenceAnswer, 1600),
          rubric: cleanText(item?.rubric, source.rubric, 1000),
          maxScore: 100,
        };
      });
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
