export type CourseQuestionKind = "理解" | "迁移" | "教回";

export type CapabilityType =
  | "conceptual_understanding"
  | "procedural_skill"
  | "problem_solving"
  | "expression_communication"
  | "retrieval_discrimination"
  | "integrated_creation";

export type EvidenceType =
  | "explanation"
  | "discrimination"
  | "procedure"
  | "problem_solution"
  | "transfer"
  | "artifact";

export type SourceStatus = "unverified" | "partially_grounded" | "grounded";
export type LessonQualityStatus = "legacy" | "pending" | "passed" | "failed";

type LearningBlockBase = {
  id: string;
  title: string;
  objectiveIds: string[];
};

export type NarrativeLearningBlock = LearningBlockBase & {
  type: "explanation" | "concept_relation" | "comparison" | "case_study" | "common_mistake" | "boundary" | "reflection" | "summary";
  body: string;
  points: string[];
};

export type WorkedExampleLearningBlock = LearningBlockBase & {
  type: "worked_example" | "demonstration" | "code_lab";
  scenario: string;
  steps: string[];
  result: string;
  verification: string;
};

export type PracticeLearningBlock = LearningBlockBase & {
  type: "guided_practice" | "retrieval_practice" | "speaking_practice";
  prompt: string;
  hints: string[];
  completionCriteria: string[];
};

export type LearningBlock = NarrativeLearningBlock | WorkedExampleLearningBlock | PracticeLearningBlock;

export type EvidenceRequirement = {
  id: string;
  objectiveId: string;
  type: EvidenceType;
  description: string;
  successCriteria: string[];
};

export type LessonContentOutput = {
  schemaVersion: "1";
  contentVersionId: string;
  lessonId: string;
  skillId: string;
  title: string;
  objective: string;
  capabilityType: CapabilityType;
  estimatedMinutes: number;
  blocks: LearningBlock[];
  evidenceRequirements: EvidenceRequirement[];
  sourceStatus: SourceStatus;
  sourceRefs: string[];
  modelSummary: string;
};

export type LessonQualityIssue = {
  code: string;
  severity: "error" | "warning";
  blockIds: string[];
  message: string;
  repairInstruction: string;
};

export type LessonQualityReport = {
  deterministicPassed: boolean;
  semanticPassed: boolean;
  score: number;
  issues: LessonQualityIssue[];
  checkerVersion: string;
  checkedAt: string;
  mode: "llm" | "rules";
  provider: string;
  model: string;
};

export type LessonContentVersionDraft = {
  content: LessonContentOutput;
  status: "ready" | "generation_failed" | "quality_failed" | "source_insufficient";
  qualityReport: LessonQualityReport;
  generation: {
    mode: "llm" | "rules";
    provider: string;
    model: string;
    promptVersion: string;
    inputHash: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    latencyMs: number;
    fallbackReason: string;
  };
};

export type LessonStatus = "locked" | "available" | "in_progress" | "passed" | "archived";
export type LessonGenerationStatus = "planned" | "generating" | "ready" | "failed";
export type LessonGenerationMode = "llm" | "demo" | "manual";

/** 客户端可见的题目：只有题干和提示，参考答案与 rubric 不下发。 */
export type CourseQuestion = {
  id: string;
  skillId: string;
  kind: CourseQuestionKind;
  contentVersionId?: string;
  taughtBlockIds?: string[];
  evidenceType?: EvidenceType;
  expectedConcepts?: string[];
  prompt: string;
  hint: string;
  maxScore: number;
};

/** 服务端持有的完整题目，仅用于生成、落库和评分。 */
export type AuthoredCourseQuestion = CourseQuestion & {
  referenceAnswer: string;
  rubric: string;
};

export type CourseLesson = {
  id: string;
  order: number;
  phase: string;
  title: string;
  durationMinutes: number;
  objective: string;
  concepts: string[];
  opening: string;
  explanation: string;
  example: string;
  practice: string;
  deliverable: string;
  requiredScore: number;
  status: LessonStatus;
  primarySkillId: string;
  difficulty: number;
  generationStatus: LessonGenerationStatus;
  generationMode: LessonGenerationMode;
  capabilityType?: CapabilityType;
  prerequisites?: string[];
  completionEvidence?: string[];
  blocks?: LearningBlock[];
  contentVersionId?: string;
  sourceStatus?: SourceStatus;
  qualityStatus?: LessonQualityStatus;
  legacyContent?: boolean;
  questions: CourseQuestion[];
};

export type AuthoredCourseLesson = Omit<CourseLesson, "questions"> & {
  questions: AuthoredCourseQuestion[];
  contentVersion?: LessonContentVersionDraft | null;
  contentVersions?: LessonContentVersionDraft[];
};

export type CourseInstructor = {
  name: string;
  role: string;
  style: string;
  openingMessage: string;
};

/** 生成阶段的课程草稿：还没有 goalId、version 和落库时间。 */
export type AuthoredLearningProgram = {
  programId: string;
  title: string;
  summary: string;
  outcomes: string[];
  cadence: string;
  instructor: CourseInstructor;
  lessons: AuthoredCourseLesson[];
  mode: "llm" | "rules" | "mixed";
  provider: string;
  model: string;
};

/** 落库后下发给客户端的课程：题目已去掉参考答案与 rubric。 */
export type LearningProgram = {
  programId: string;
  goalId: string;
  version: number;
  title: string;
  summary: string;
  outcomes: string[];
  cadence: string;
  instructor: CourseInstructor;
  lessons: CourseLesson[];
  mode: "llm" | "rules" | "mixed";
  provider: string;
  createdAt: string;
};

export type CourseGenerationInput = {
  subject: string;
  goal: string;
  background?: string;
  weeklyHours?: number;
  lessonCount?: number;
};

export type LessonTutorReply = {
  lessonId: string;
  reply: string;
  followUp: string;
  mode: "llm" | "rules";
  provider: string;
};

export type CourseQuestionFeedback = {
  questionId: string;
  score: number;
  maxScore: number;
  feedback: string;
  reference: string;
};

/** 评分 Agent 的输出，尚未与数据库中的尝试次数合并。 */
export type CourseLessonGradeDraft = {
  lessonId: string;
  score: number;
  summary: string;
  nextStep: string;
  feedback: CourseQuestionFeedback[];
  gradedBy: "llm" | "rules";
  provider: string;
  model: string;
};

export type CourseLessonGrade = CourseLessonGradeDraft & {
  level: "不合格" | "合格" | "良" | "优";
  passed: boolean;
  attemptNumber: number;
  mastery?: { skillId: string; score: number; confidence: number; evidenceCount: number };
  nextLessonId?: string;
};

export type GoalSkill = {
  id: string;
  name: string;
  description: string;
  targetLevel: number;
  weight: number;
};

export type DiagnosticQuestionKind = "concept" | "explanation" | "application" | "debugging" | "design";

export type DiagnosticQuestion = {
  id: string;
  skillId: string;
  kind: DiagnosticQuestionKind;
  difficulty: number;
  prompt: string;
  hint: string;
  maxScore: number;
};

export type DiagnosticAssessment = {
  id: string;
  goalId: string;
  status: "generated" | "in_progress" | "completed";
  questions: DiagnosticQuestion[];
  source: "llm" | "rules" | "manual";
  provider: string;
  adaptive: boolean;
  answeredCount: number;
  minQuestions: number;
  maxQuestions: number;
};

export type DiagnosticQuestionResult = {
  questionId: string;
  score: number;
  maxScore: number;
  feedback: string;
  direction: "harder" | "easier" | "same" | "complete";
  nextDifficulty?: number;
};

export type DiagnosticGrade = {
  score: number;
  level: "不合格" | "合格" | "良" | "优";
  summary: string;
  skillScores: Record<string, number>;
  feedback: CourseQuestionFeedback[];
};

export type GoalPreparation = {
  nextAction: "diagnostic" | "course";
  diagnostic?: DiagnosticAssessment;
  program?: LearningProgram;
};
