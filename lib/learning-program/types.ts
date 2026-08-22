export type CourseQuestionKind = "理解" | "迁移" | "教回";

export type CourseQuestion = {
  id: string;
  kind: CourseQuestionKind;
  prompt: string;
  hint: string;
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
  questions: CourseQuestion[];
};

export type CourseInstructor = {
  name: string;
  role: string;
  style: string;
  openingMessage: string;
};

export type LearningProgram = {
  courseId: string;
  title: string;
  subject: string;
  goal: string;
  background: string;
  weeklyHours: number;
  summary: string;
  outcomes: string[];
  cadence: string;
  instructor: CourseInstructor;
  lessons: CourseLesson[];
  mode: "llm" | "rules";
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
  feedback: string;
  reference: string;
};

export type CourseLessonGrade = {
  lessonId: string;
  score: number;
  summary: string;
  nextStep: string;
  feedback: CourseQuestionFeedback[];
  gradedBy: "llm" | "rules";
  provider: string;
};
