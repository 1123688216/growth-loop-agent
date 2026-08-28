import type { AuthoredCourseQuestion, CourseInstructor, CourseQuestionFeedback, DiagnosticQuestionKind } from "@/lib/learning-program/types";

export type GoalContext = {
  id: string;
  title: string;
  description: string;
  background: string;
  selfLevel: "beginner" | "familiar" | "intermediate";
  weeklyHours: number;
};

export type SkillDraft = {
  key: string;
  name: string;
  description: string;
  targetLevel: number;
  weight: number;
};

export type PersistedSkill = Omit<SkillDraft, "key"> & { id: string };

export type CourseOutlineDraft = {
  title: string;
  summary: string;
  outcomes: string[];
  cadence: string;
  instructor: CourseInstructor;
  lessons: Array<{
    title: string;
    phase: string;
    objective: string;
    concepts: string[];
    durationMinutes: number;
    skillId: string;
    difficulty: number;
  }>;
};

export type LessonMaterialDraft = {
  opening: string;
  explanation: string;
  example: string;
  practice: string;
  deliverable: string;
  concepts: string[];
};

export type DiagnosticQuestionDraft = {
  skillId: string;
  kind: DiagnosticQuestionKind;
  difficulty: number;
  prompt: string;
  hint: string;
  referenceAnswer: string;
  rubric: string;
  maxScore: number;
};

export type AssessmentGradeDraft = {
  score: number;
  summary: string;
  nextStep: string;
  feedback: CourseQuestionFeedback[];
  skillScores: Record<string, number>;
  gradedBy: "llm" | "rules";
  provider: string;
  model: string;
};

export type AdaptiveAnswerGradeDraft = {
  score: number;
  feedback: string;
  evidenceSummary: string;
  gradedBy: "llm" | "rules";
  provider: string;
  model: string;
};

export type TutorLessonInput = {
  goal: GoalContext;
  skill: PersistedSkill;
  lesson: CourseOutlineDraft["lessons"][number];
  mastery: { score: number; confidence: number };
};

export type TutorCheckInput = TutorLessonInput & { material: LessonMaterialDraft };
export type TutorGradeInput = TutorCheckInput & { questions: AuthoredCourseQuestion[]; answers: Record<string, string> };
