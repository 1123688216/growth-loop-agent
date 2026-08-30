"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  BookOpen,
  CircleAlert,
  Check,
  ChevronRight,
  CircleCheck,
  Clock3,
  Eye,
  FlaskConical,
  GitCompareArrows,
  Lightbulb,
  ListChecks,
  LoaderCircle,
  MessageCircle,
  Mic,
  Network,
  OctagonAlert,
  PenLine,
  Quote,
  RotateCcw,
  Send,
  Sparkles,
  Target,
  TriangleAlert,
  Wrench,
} from "lucide-react";

import type {
  CourseLesson,
  CourseLessonGrade,
  LearningBlock,
  LearningProgram,
  LessonTutorReply,
} from "@/lib/learning-program/types";
import type { Goal } from "@/lib/demo-data";

/** 本地只缓存当前课程的 id，课程正文始终从服务端拉取。 */
export const PROGRAM_STORAGE_KEY = "growth-loop.learning-program.program-id.v1";

type LearningStudioProps = {
  compact?: boolean;
  onBack?: () => void;
  onAddLesson?: (lesson: CourseLesson) => void;
  programId?: string;
  targetLessonId?: string;
  onLessonPassed?: (lesson: CourseLesson, grade: CourseLessonGrade) => void;
  goals?: Goal[];
  onSelectGoal?: (goal: Goal) => Promise<void>;
};

function readCachedProgramId() {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(PROGRAM_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

function cacheProgramId(programId: string) {
  try {
    window.localStorage.setItem(PROGRAM_STORAGE_KEY, programId);
  } catch {
    // 无痕模式下写不进缓存也不影响课程读取。
  }
}

async function fetchProgram(reference: string) {
  const response = await fetch(`/api/learning-program?program=${encodeURIComponent(reference)}`);
  if (!response.ok) throw new Error("program unavailable");
  const data = (await response.json()) as { program: LearningProgram | null };
  return data.program;
}

function courseStatusLabel(mode: LearningProgram["mode"]) {
  return mode === "llm" ? "AI 编排" : "本地演示";
}

function sourceStatusLabel(status: CourseLesson["sourceStatus"]) {
  if (status === "grounded") return "来源已验证";
  if (status === "partially_grounded") return "部分来源可追溯";
  return "模型知识 · 未验证";
}

function passedLessonIds(program: LearningProgram) {
  return program.lessons.filter((lesson) => lesson.status === "passed").map((lesson) => lesson.id);
}

export default function LearningStudio({
  compact = false,
  onBack,
  onAddLesson,
  programId,
  targetLessonId,
  onLessonPassed,
  goals = [],
  onSelectGoal,
}: LearningStudioProps) {
  const [program, setProgram] = useState<LearningProgram | null>(null);
  const [activeLessonId, setActiveLessonId] = useState("");
  const [completedLessonIds, setCompletedLessonIds] = useState<string[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [grades, setGrades] = useState<Record<string, CourseLessonGrade>>({});
  const [tutorInput, setTutorInput] = useState("");
  const [tutorReply, setTutorReply] = useState<LessonTutorReply | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isTutorBusy, setIsTutorBusy] = useState(false);
  const [isGrading, setIsGrading] = useState(false);
  const [isRetryingLesson, setIsRetryingLesson] = useState(false);
  const [error, setError] = useState("");

  const applyProgram = useCallback((next: LearningProgram) => {
    cacheProgramId(next.programId);
    setProgram(next);
    setCompletedLessonIds(passedLessonIds(next));
    setActiveLessonId((current) => next.lessons.some((lesson) => lesson.id === current) ? current : next.lessons[0]?.id || "");
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const cached = programId || readCachedProgramId();
      let next = await fetchProgram(cached || "current");
      // 缓存里的 programId 可能已经失效（换账号、课程重新生成），退回读取最近一份课程。
      if (!next && cached) next = await fetchProgram("current");
      return next;
    }

    // programId 变化时保留当前课程正文，等新课程到达再替换，避免中途闪一次空白。
    void load()
      .then((next) => {
        if (cancelled) return;
        if (!next) {
          setProgram(null);
          return;
        }
        applyProgram(next);
      })
      .catch(() => {
        if (!cancelled) setError("课程暂时读取不到，请稍后刷新页面。");
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => { cancelled = true; };
  }, [applyProgram, programId]);

  const activeLesson = useMemo(
    () => program?.lessons.find((lesson) => lesson.id === activeLessonId) || program?.lessons[0] || null,
    [activeLessonId, program],
  );

  useEffect(() => {
    if (!program || !targetLessonId) return;
    if (!program.lessons.some((lesson) => lesson.id === targetLessonId)) return;
    const timer = window.setTimeout(() => setActiveLessonId(targetLessonId), 0);
    return () => window.clearTimeout(timer);
  }, [program, targetLessonId]);

  async function askTutor() {
    if (!program || !activeLesson || !tutorInput.trim()) return;
    setIsTutorBusy(true);
    setError("");
    try {
      const response = await fetch("/api/learning-program", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "tutor",
          programId: program.programId,
          lessonId: activeLesson.id,
          message: tutorInput.trim(),
        }),
      });
      const data = (await response.json()) as { reply?: LessonTutorReply; error?: string };
      if (!response.ok || !data.reply) throw new Error(data.error || "老师暂时没有回应。");
      setTutorReply(data.reply);
      setTutorInput("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "老师暂时没有回应。");
    } finally {
      setIsTutorBusy(false);
    }
  }

  async function gradeLesson() {
    if (!program || !activeLesson) return;
    const hasAnswer = activeLesson.questions.some((question) => answers[question.id]?.trim());
    if (!hasAnswer) {
      setError("先写下一道题的想法，老师才能给你有用的反馈。");
      return;
    }
    setIsGrading(true);
    setError("");
    try {
      const response = await fetch("/api/learning-program", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "grade",
          programId: program.programId,
          lessonId: activeLesson.id,
          answers,
        }),
      });
      const data = (await response.json()) as { grade?: CourseLessonGrade; program?: LearningProgram | null; error?: string };
      if (!response.ok || !data.grade) throw new Error(data.error || "暂时无法评分。");
      const grade = data.grade;
      setGrades((current) => ({ ...current, [activeLesson.id]: grade }));
      if (data.program) applyProgram(data.program);
      if (!grade.passed) return;
      if (!completedLessonIds.includes(activeLesson.id)) {
        setCompletedLessonIds((current) => [...current, activeLesson.id]);
        onLessonPassed?.(activeLesson, grade);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "暂时无法评分。");
    } finally {
      setIsGrading(false);
    }
  }

  async function retryLesson() {
    if (!program || !activeLesson) return;
    setIsRetryingLesson(true);
    setError("");
    try {
      const response = await fetch("/api/learning-program", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "retry-lesson", programId: program.programId, lessonId: activeLesson.id }),
      });
      const data = (await response.json()) as { program?: LearningProgram; error?: string };
      if (!response.ok || !data.program) throw new Error(data.error || "课程重新生成失败。");
      applyProgram(data.program);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "课程重新生成失败。");
    } finally {
      setIsRetryingLesson(false);
    }
  }

  function chooseLesson(lesson: CourseLesson) {
    setActiveLessonId(lesson.id);
    setTutorReply((current) => current && current.lessonId === lesson.id ? current : null);
    setError("");
  }

  return (
    <section className={`learning-studio ${compact ? "is-compact" : ""}`} aria-label="AI 学习课程">
      {compact && onBack && <div className="learning-compact-toolbar"><button className="learning-back-button" onClick={onBack}><ArrowLeft size={16} /> 返回计划</button></div>}

      {error && <p className="learning-error" role="alert">{error}</p>}

      {goals.length > 0 && <section className="learning-goal-switch" aria-label="切换学习目标">
        <div><span className="eyebrow">LEARNING GOALS</span><strong>切换学习目标</strong><small>课程、诊断和进度分别归属于各自目标。</small></div>
        <div className="learning-goal-switch-list">{goals.map((goal) => {
          const active = program?.goalId === goal.id;
          const needsDiagnostic = goal.diagnosticStatus === "pending" || goal.diagnosticStatus === "in_progress";
          return <button key={goal.id} type="button" className={active ? "active" : ""} onClick={() => void onSelectGoal?.(goal)} aria-pressed={active}>
            <strong>{goal.title}</strong>
            <span>{active ? "当前课程" : needsDiagnostic ? "继续初始诊断" : goal.learningProgramId ? "切换课程" : "准备学习路径"}</span>
          </button>;
        })}</div>
      </section>}

      {program && activeLesson && (
        <section className="learning-course-shell">
          <div className="learning-course-summary">
            <div>
              <span className="learning-course-kicker"><Sparkles size={13} /> {courseStatusLabel(program.mode)}</span>
              <h3>{program.title}</h3>
              <p>{program.summary}</p>
            </div>
            <div className="learning-course-metrics"><span><Clock3 size={14} /> {program.lessons.length} 节</span><span><CircleCheck size={14} /> {completedLessonIds.length}/{program.lessons.length} 已完成</span></div>
            <div className="learning-outcomes">{program.outcomes.map((outcome) => <span key={outcome}>{outcome}</span>)}</div>
          </div>

          <div className="learning-course-grid">
            <aside className="learning-passport" aria-label="课程章节">
              <div className="learning-passport-intro"><span>学习路线</span><p>{program.cadence}</p></div>
              <div className="learning-lesson-list">
                {program.lessons.map((lesson) => {
                  const isActive = lesson.id === activeLesson.id;
                  const isDone = completedLessonIds.includes(lesson.id);
                  return <button key={lesson.id} className={`learning-lesson-link ${isActive ? "is-active" : ""} ${isDone ? "is-done" : ""} ${lesson.generationStatus !== "ready" ? "is-planned" : ""}`} onClick={() => chooseLesson(lesson)}>
                    <span className="learning-lesson-index">{isDone ? <Check size={13} /> : String(lesson.order).padStart(2, "0")}</span>
                    <span><small>{lesson.phase}</small><strong>{lesson.title}</strong><em>{lesson.generationStatus === "ready" ? `${lesson.durationMinutes} 分钟` : "待前一节通过后生成"}</em></span>
                    <ChevronRight size={15} />
                  </button>;
                })}
              </div>
            </aside>

            <article className="learning-lesson-card">
              <div className="learning-lesson-title-row">
                <div><span>第 {activeLesson.order} 节 · {activeLesson.phase}</span><h3>{activeLesson.title}</h3><p>{activeLesson.objective}</p></div>
                <div className={`learning-complete-button ${completedLessonIds.includes(activeLesson.id) ? "is-complete" : ""}`} role="status">
                  {completedLessonIds.includes(activeLesson.id)
                    ? <><Check size={15} /> 已完成 · {grades[activeLesson.id]?.level || "合格"}</>
                    : grades[activeLesson.id]
                      ? <><CircleCheck size={15} /> 尚未合格 · {grades[activeLesson.id].score} 分</>
                      : <><CircleCheck size={15} /> 答题合格后完成</>}
                </div>
              </div>
              <div className="learning-lesson-metadata" aria-label="课程内容状态">
                <span className={activeLesson.qualityStatus === "passed" ? "is-passed" : ""}>{activeLesson.legacyContent ? "旧版课程" : activeLesson.qualityStatus === "passed" ? "质量门禁已通过" : "等待质量检查"}</span>
                <span>{sourceStatusLabel(activeLesson.sourceStatus)}</span>
                {activeLesson.capabilityType && <span>{capabilityLabel(activeLesson.capabilityType)}</span>}
              </div>
              {/* 有结构化教学块时，块标题本身就是大纲，再列一排概念标签只是重复。 */}
              {!activeLesson.blocks?.length && activeLesson.concepts.length > 0
                && <div className="learning-concepts">{activeLesson.concepts.map((concept) => <span key={concept}>{concept}</span>)}</div>}

              {activeLesson.generationStatus !== "ready" ? <section className="learning-planned-placeholder">
                <span className="eyebrow">ADAPTIVE LESSON</span>
                {activeLesson.generationStatus === "failed" ? <>
                  <h4><CircleAlert size={17} /> 本节没有通过教学质量门禁</h4>
                  <p>失败内容和质量报告已经保存，但不会用通用模板伪装成正式课程。可以重新生成，成功后才会开放课后考核。</p>
                  <button className="learning-retry-lesson" type="button" onClick={() => void retryLesson()} disabled={isRetryingLesson}>
                    {isRetryingLesson ? <LoaderCircle className="spin" size={15} /> : <RotateCcw size={15} />}
                    {isRetryingLesson ? "正在重新生成" : "重新生成本节"}
                  </button>
                </> : <>
                  <h4>本节先保留路线，不提前生成正文</h4>
                  <p>通过前一节的导师考核后，系统会根据最新掌握度生成本节讲解、练习和巩固题，避免整套课程一开始就固定。</p>
                </>}
              </section> : <>
              {activeLesson.blocks?.length ? <LessonReader
                key={`${activeLesson.id}:${activeLesson.contentVersionId || "legacy"}`}
                lesson={activeLesson}
                pages={buildLessonPages(activeLesson)}
                onAddLesson={onAddLesson}
                checkSlot={<section className="learning-quiz-block">
                  <div className="learning-quiz-heading"><div><span>课后理解检查</span><h4>先答，再看反馈。</h4></div><button onClick={() => void gradeLesson()} disabled={isGrading}>{isGrading ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />}{grades[activeLesson.id] ? "重新评分" : "请老师评分"}</button></div>
                  <div className="learning-question-list">
                    {activeLesson.questions.map((question, index) => <label className="learning-question" key={question.id}><span>{String(index + 1).padStart(2, "0")} · {question.kind}{question.taughtBlockIds?.length ? ` · 对应 ${question.taughtBlockIds.length} 个教学块` : ""}</span><strong>{question.prompt}</strong><small>{question.hint}</small><textarea value={answers[question.id] || ""} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))} placeholder="用自己的话写下理解，不需要写得很长。" rows={3} /></label>)}
                  </div>
                  {grades[activeLesson.id] && <GradeCard grade={grades[activeLesson.id]} questions={activeLesson.questions} />}
                </section>}
                tutorSlot={<>
                  <section className="learning-instructor-card">
                    <div className="learning-instructor-avatar">岚</div>
                    <div className="learning-instructor-copy"><span>{program.instructor.name}</span><strong>{program.instructor.role}</strong><p>{tutorReply?.lessonId === activeLesson.id ? tutorReply.reply : program.instructor.openingMessage}</p>{tutorReply?.lessonId === activeLesson.id && <small>{tutorReply.followUp}</small>}</div>
                  </section>
                  <div className="learning-tutor-composer"><MessageCircle size={16} /><input value={tutorInput} onChange={(event) => setTutorInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void askTutor(); }} maxLength={1200} placeholder="卡在哪、想让老师举什么例子？" /><button onClick={() => void askTutor()} disabled={isTutorBusy || !tutorInput.trim()} aria-label="向 AI 讲师提问">{isTutorBusy ? <LoaderCircle className="spin" size={17} /> : <Send size={17} />}</button></div>
                </>}
              /> : <>
              <div className="learning-lesson-content">
                <section><span className="learning-content-label"><Target size={14} /> 这一节先抓住</span><p>{activeLesson.opening}</p></section>
                <section><span className="learning-content-label"><BookOpen size={14} /> 导师讲解</span><p>{activeLesson.explanation}</p></section>
                <section className="learning-example"><span className="learning-content-label"><Sparkles size={14} /> 一个例子</span><p>{activeLesson.example}</p></section>
                <section className="learning-practice"><span className="learning-content-label"><PenLine size={14} /> 动手试试</span><p>{activeLesson.practice}</p><strong>本节交付物：{activeLesson.deliverable}</strong><div className="learning-practice-actions">{onAddLesson && <button onClick={() => onAddLesson(activeLesson)}>放进今日计划 <ArrowUpRight size={14} /></button>}</div></section>
              </div>

              <section className="learning-quiz-block">
                <div className="learning-quiz-heading"><div><span>课后理解检查</span><h4>先答，再看反馈。</h4></div><button onClick={() => void gradeLesson()} disabled={isGrading}>{isGrading ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />}{grades[activeLesson.id] ? "重新评分" : "请老师评分"}</button></div>
                <div className="learning-question-list">
                  {activeLesson.questions.map((question, index) => <label className="learning-question" key={question.id}><span>{String(index + 1).padStart(2, "0")} · {question.kind}{question.taughtBlockIds?.length ? ` · 对应 ${question.taughtBlockIds.length} 个教学块` : ""}</span><strong>{question.prompt}</strong><small>{question.hint}</small><textarea value={answers[question.id] || ""} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))} placeholder="用自己的话写下理解，不需要写得很长。" rows={3} /></label>)}
                </div>
                {grades[activeLesson.id] && <GradeCard grade={grades[activeLesson.id]} questions={activeLesson.questions} />}
              </section>

              {/* 旧版课程没有分页，正文和考核同屏，导师区只能常驻。 */}
              <section className="learning-instructor-card">
                <div className="learning-instructor-avatar">岚</div>
                <div className="learning-instructor-copy"><span>{program.instructor.name}</span><strong>{program.instructor.role}</strong><p>{tutorReply?.lessonId === activeLesson.id ? tutorReply.reply : program.instructor.openingMessage}</p>{tutorReply?.lessonId === activeLesson.id && <small>{tutorReply.followUp}</small>}</div>
              </section>
              <div className="learning-tutor-composer"><MessageCircle size={16} /><input value={tutorInput} onChange={(event) => setTutorInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void askTutor(); }} maxLength={1200} placeholder="卡在哪、想让老师举什么例子？" /><button onClick={() => void askTutor()} disabled={isTutorBusy || !tutorInput.trim()} aria-label="向 AI 讲师提问">{isTutorBusy ? <LoaderCircle className="spin" size={17} /> : <Send size={17} />}</button></div>
              </>}
              </>}
            </article>
          </div>
        </section>
      )}

      {isLoading && !program && <section className="learning-empty-course"><span><LoaderCircle className="spin" size={18} /></span><div><strong>正在读取课程……</strong><p>课程正文保存在服务端，换设备或清缓存后也能继续。</p></div></section>}

      {!isLoading && !program && <section className="learning-empty-course"><span><Sparkles size={18} /></span><div><strong>还没有与目标关联的课程。</strong><p>请先到计划页创建目标。AI 会根据目标、完成标准、当前基础和每周投入直接生成课程。</p>{onBack && <button className="learning-back-button" onClick={onBack}><ArrowLeft size={16} /> 前往计划创建目标</button>}</div></section>}
    </section>
  );
}

function capabilityLabel(type: NonNullable<CourseLesson["capabilityType"]>) {
  return ({
    conceptual_understanding: "概念理解",
    procedural_skill: "程序性技能",
    problem_solving: "问题解决",
    expression_communication: "表达沟通",
    retrieval_discrimination: "记忆辨析",
    integrated_creation: "综合创作",
  } as const)[type];
}

const BLOCK_META = {
  explanation: { label: "概念讲解", icon: BookOpen },
  concept_relation: { label: "概念关系", icon: Network },
  comparison: { label: "对比辨析", icon: GitCompareArrows },
  worked_example: { label: "完整例题", icon: PenLine },
  case_study: { label: "案例分析", icon: Quote },
  demonstration: { label: "步骤示范", icon: ListChecks },
  common_mistake: { label: "常见错误", icon: TriangleAlert },
  boundary: { label: "适用边界", icon: OctagonAlert },
  guided_practice: { label: "引导练习", icon: Wrench },
  retrieval_practice: { label: "主动回忆", icon: Lightbulb },
  reflection: { label: "反思", icon: MessageCircle },
  summary: { label: "本节总结", icon: CircleCheck },
  code_lab: { label: "代码实验", icon: FlaskConical },
  speaking_practice: { label: "表达练习", icon: Mic },
} as const;

/**
 * 主动回忆的提示基本等于答案，一次全列出来这个块就退化成阅读块了。
 * 引导练习同理：提示应当一条条给，而不是摊开。表达练习的提示是评价标准，不遮。
 */
function PracticeHints({ hints, gated }: { hints: string[]; gated: boolean }) {
  const [revealed, setRevealed] = useState(gated ? 0 : hints.length);
  if (!hints.length) return null;
  const remaining = hints.length - revealed;
  return <div className="learning-block-hints">
    {revealed > 0 && <ul>{hints.slice(0, revealed).map((hint) => <li key={hint}>{hint}</li>)}</ul>}
    {remaining > 0 && <button type="button" className="learning-hint-button" onClick={() => setRevealed((count) => count + 1)}>
      <Eye size={13} /> {revealed === 0 ? `先自己想一想，需要时展开提示（共 ${hints.length} 条）` : `再来一条提示（还剩 ${remaining} 条）`}
    </button>}
  </div>;
}

function LearningBlockCard({ block, index }: { block: LearningBlock; index: number }) {
  const meta = BLOCK_META[block.type];
  const Icon = meta.icon;
  return <section className={`learning-block learning-block-${block.type}`}>
    <div className="learning-block-heading">
      <span title={`第 ${index + 1} 块`}><Icon size={12} /></span>
      <small>{meta.label}</small>
      <strong>{block.title}</strong>
    </div>
    {"body" in block && <><p>{block.body}</p>{block.points.length > 0 && <ul>{block.points.map((point) => <li key={point}>{point}</li>)}</ul>}</>}
    {"scenario" in block && <><p><b>情境：</b>{block.scenario}</p><ol>{block.steps.map((step) => <li key={step}>{step}</li>)}</ol><div className="learning-block-result"><span>结果</span><p>{block.result}</p><span>验证</span><p>{block.verification}</p></div></>}
    {"prompt" in block && <><p>{block.prompt}</p><PracticeHints hints={block.hints} gated={block.type !== "speaking_practice"} /><div className="learning-block-criteria"><strong>完成标准</strong>{block.completionCriteria.map((criterion) => <span key={criterion}><Check size={12} /> {criterion}</span>)}</div></>}
  </section>;
}

type LessonPage =
  | { kind: "block"; block: LearningBlock }
  | { kind: "deliverable" }
  | { kind: "check" };

function buildLessonPages(lesson: CourseLesson): LessonPage[] {
  if (!lesson.blocks?.length) return [];
  return [
    ...lesson.blocks.map((block) => ({ kind: "block" as const, block })),
    { kind: "deliverable" as const },
    { kind: "check" as const },
  ];
}

function pageLabel(page: LessonPage) {
  if (page.kind === "block") return BLOCK_META[page.block.type].label;
  return page.kind === "deliverable" ? "本节交付物" : "课后理解检查";
}

function readingKey(lesson: CourseLesson) {
  return `growth-loop.reading.${lesson.id}:${lesson.contentVersionId || "legacy"}`;
}

/**
 * 一次只渲染一页，避免整节课在一屏里纵向铺开。
 * 由调用方用 key={lessonId:contentVersionId} 挂载，换课或课程重生成时自然重置页码，
 * 不需要在 effect 里同步 setState。
 */
function LessonReader({ lesson, pages, onAddLesson, checkSlot, tutorSlot }: {
  lesson: CourseLesson;
  pages: LessonPage[];
  onAddLesson?: (lesson: CourseLesson) => void;
  checkSlot: ReactNode;
  tutorSlot: ReactNode;
}) {
  const [pageIndex, setPageIndex] = useState(() => {
    try {
      const saved = Number(window.localStorage.getItem(readingKey(lesson)));
      return Number.isInteger(saved) && saved >= 0 && saved < pages.length ? saved : 0;
    } catch {
      return 0;
    }
  });

  const goTo = useCallback((next: number) => {
    const clamped = Math.max(0, Math.min(pages.length - 1, next));
    setPageIndex(clamped);
    try {
      window.localStorage.setItem(readingKey(lesson), String(clamped));
    } catch {
      // 无痕模式下记不住阅读位置，不影响翻页。
    }
  }, [lesson, pages.length]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      // 正在输入答案或提问时不抢方向键。
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (target?.isContentEditable) return;
      setPageIndex((current) => {
        const next = Math.max(0, Math.min(pages.length - 1, current + (event.key === "ArrowRight" ? 1 : -1)));
        try { window.localStorage.setItem(readingKey(lesson), String(next)); } catch { /* 忽略 */ }
        return next;
      });
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lesson, pages.length]);

  const page = pages[Math.min(pageIndex, pages.length - 1)];
  if (!page) return null;

  return <div className="learning-reader">
    <div className="learning-reader-bar">
      <span className="learning-reader-counter">{String(pageIndex + 1).padStart(2, "0")} / {String(pages.length).padStart(2, "0")}</span>
      <span className="learning-reader-kind">{pageLabel(page)}</span>
      <div className="learning-reader-dots" role="tablist" aria-label="本节页面">
        {pages.map((item, index) => <button
          key={index}
          type="button"
          role="tab"
          aria-selected={index === pageIndex}
          aria-label={`第 ${index + 1} 页 · ${pageLabel(item)}`}
          title={`${index + 1}. ${pageLabel(item)}`}
          className={`${index === pageIndex ? "is-active" : ""} ${index < pageIndex ? "is-read" : ""} learning-reader-dot-${item.kind}`}
          onClick={() => goTo(index)}
        />)}
      </div>
    </div>

    <div className="learning-reader-stage">
      {page.kind === "block" && <LearningBlockCard block={page.block} index={pageIndex} />}
      {page.kind === "deliverable" && <section className="learning-block learning-block-deliverable">
        <div className="learning-block-heading"><span><Target size={12} /></span><small>本节交付物</small><strong>学完这一节要拿出什么</strong></div>
        <p>{lesson.deliverable}</p>
        {onAddLesson && <div className="learning-practice-actions"><button onClick={() => onAddLesson(lesson)}>放进今日计划 <ArrowUpRight size={14} /></button></div>}
      </section>}
      {page.kind === "check" && checkSlot}
    </div>

    <div className="learning-reader-nav">
      <button type="button" onClick={() => goTo(pageIndex - 1)} disabled={pageIndex === 0}>
        <ArrowLeft size={15} /> 上一页
      </button>
      <span>{pageIndex === pages.length - 1 ? "本节最后一页" : `下一页：${pageLabel(pages[pageIndex + 1])}`}</span>
      <button type="button" onClick={() => goTo(pageIndex + 1)} disabled={pageIndex === pages.length - 1}>
        下一页 <ChevronRight size={15} />
      </button>
    </div>

    {/* 考核页不提供导师问答：能一边答题一边问老师，这次考核就说明不了任何事。 */}
    {page.kind === "check"
      ? <p className="learning-tutor-locked"><CircleAlert size={13} /> 考核期间导师问答已关闭。需要讲解请先翻回正文页，或提交后再来问。</p>
      : tutorSlot}
  </div>;
}

function GradeCard({ grade, questions }: { grade: CourseLessonGrade; questions: CourseLesson["questions"] }) {
  return <section className="learning-grade-card"><div className="learning-grade-score"><span>本节理解度</span><strong>{grade.score}</strong><em>/ 100</em></div><div className="learning-grade-summary"><strong>{grade.summary}</strong><p>下一步：{grade.nextStep}</p><small>第 {grade.attemptNumber} 次评测 · {grade.level}</small></div><div className="learning-grade-feedback">{grade.feedback.map((item, index) => <div key={item.questionId}><span>{questions[index]?.kind || "问题"} · {item.score} 分</span><p>{item.feedback}</p><small>参考答案：{item.reference}</small></div>)}</div><button className="learning-grade-reset" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}><RotateCcw size={14} /> 回到本节开头</button></section>;
}
