"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronRight,
  CircleCheck,
  Clock3,
  LoaderCircle,
  MessageCircle,
  PenLine,
  RotateCcw,
  Send,
  Sparkles,
  Target,
} from "lucide-react";

import type {
  CourseLesson,
  CourseLessonGrade,
  LearningProgram,
  LessonTutorReply,
} from "@/lib/learning-program/types";

const COURSE_STORAGE_KEY = "growth-loop.learning-program.v1";
const COMPLETED_STORAGE_KEY = "growth-loop.learning-program.completed.v1";

type LearningStudioProps = {
  compact?: boolean;
  onBack?: () => void;
  onAddLesson?: (lesson: CourseLesson) => void;
};

function readStoredCourse() {
  if (typeof window === "undefined") return null;
  try {
    const value = JSON.parse(window.localStorage.getItem(COURSE_STORAGE_KEY) || "null") as unknown;
    if (!value || typeof value !== "object" || !Array.isArray((value as LearningProgram).lessons)) return null;
    return value as LearningProgram;
  } catch {
    return null;
  }
}

function readCompleted(courseId?: string) {
  if (typeof window === "undefined" || !courseId) return [] as string[];
  try {
    const value = JSON.parse(window.localStorage.getItem(COMPLETED_STORAGE_KEY) || "[]") as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [] as string[];
  }
}

function courseStatusLabel(mode: LearningProgram["mode"]) {
  return mode === "llm" ? "AI 编排" : "本地课程";
}

export default function LearningStudio({ compact = false, onBack, onAddLesson }: LearningStudioProps) {
  const [subject, setSubject] = useState("Agent 系统设计与自己的 Agent 原型");
  const [goal, setGoal] = useState("理解 Agent 的任务闭环、工具调用和状态管理，并做出一个能处理学习记录的最小 Agent。");
  const [background, setBackground] = useState("会基础 TypeScript 和 Next.js，希望先建立正确架构，再开始开发。");
  const [weeklyHours, setWeeklyHours] = useState(4);
  const [program, setProgram] = useState<LearningProgram | null>(null);
  const [activeLessonId, setActiveLessonId] = useState("");
  const [completedLessonIds, setCompletedLessonIds] = useState<string[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [grades, setGrades] = useState<Record<string, CourseLessonGrade>>({});
  const [tutorInput, setTutorInput] = useState("");
  const [tutorReply, setTutorReply] = useState<LessonTutorReply | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isTutorBusy, setIsTutorBusy] = useState(false);
  const [isGrading, setIsGrading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const stored = readStoredCourse();
    if (!stored) return;
    const timer = window.setTimeout(() => {
      setProgram(stored);
      setActiveLessonId(stored.lessons[0]?.id || "");
      setCompletedLessonIds(readCompleted(stored.courseId));
      setTutorReply({
        lessonId: stored.lessons[0]?.id || "",
        reply: stored.instructor.openingMessage,
        followUp: "告诉我你准备从哪一个真实问题开始。",
        mode: stored.mode,
        provider: stored.provider,
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const activeLesson = useMemo(
    () => program?.lessons.find((lesson) => lesson.id === activeLessonId) || program?.lessons[0] || null,
    [activeLessonId, program],
  );

  function persist(next: LearningProgram, completed = completedLessonIds) {
    window.localStorage.setItem(COURSE_STORAGE_KEY, JSON.stringify(next));
    window.localStorage.setItem(COMPLETED_STORAGE_KEY, JSON.stringify(completed));
  }

  async function generateProgram() {
    if (!subject.trim() || !goal.trim()) {
      setError("先告诉我学习什么，以及希望最终做到什么。");
      return;
    }
    setIsGenerating(true);
    setError("");
    try {
      const response = await fetch("/api/learning-program", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "generate",
          subject: subject.trim(),
          goal: goal.trim(),
          background: background.trim(),
          weeklyHours,
          lessonCount: 5,
        }),
      });
      const data = (await response.json()) as { program?: LearningProgram; error?: string };
      if (!response.ok || !data.program) throw new Error(data.error || "课程暂时没有生成成功。");
      setProgram(data.program);
      setActiveLessonId(data.program.lessons[0]?.id || "");
      setCompletedLessonIds([]);
      setAnswers({});
      setGrades({});
      const opening: LessonTutorReply = {
        lessonId: data.program.lessons[0]?.id || "",
        reply: data.program.instructor.openingMessage,
        followUp: "先用一句话说说，你希望这门课结束时能亲手完成什么？",
        mode: data.program.mode,
        provider: data.program.provider,
      };
      setTutorReply(opening);
      persist(data.program, []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "课程暂时不可用，请稍后重试。");
    } finally {
      setIsGenerating(false);
    }
  }

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
          course: program,
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
          course: program,
          lessonId: activeLesson.id,
          answers,
        }),
      });
      const data = (await response.json()) as { grade?: CourseLessonGrade; error?: string };
      if (!response.ok || !data.grade) throw new Error(data.error || "暂时无法评分。");
      setGrades((current) => ({ ...current, [activeLesson.id]: data.grade! }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "暂时无法评分。");
    } finally {
      setIsGrading(false);
    }
  }

  function chooseLesson(lesson: CourseLesson) {
    setActiveLessonId(lesson.id);
    setTutorReply((current) => current && current.lessonId === lesson.id ? current : null);
    setError("");
  }

  function toggleCompleted(lesson: CourseLesson) {
    if (!program) return;
    const next = completedLessonIds.includes(lesson.id)
      ? completedLessonIds.filter((id) => id !== lesson.id)
      : [...completedLessonIds, lesson.id];
    setCompletedLessonIds(next);
    persist(program, next);
  }

  function loadAgentStarter() {
    setSubject("Agent 系统设计与自己的 Agent 原型");
    setGoal("理解 Agent 的任务闭环、工具调用和状态管理，并做出一个能处理学习记录的最小 Agent。");
    setBackground("会基础 TypeScript 和 Next.js，希望先建立正确架构，再开始开发。");
    setWeeklyHours(4);
  }

  return (
    <section className={`learning-studio ${compact ? "is-compact" : ""}`} aria-label="AI 学习课程">
      <header className="learning-studio-heading">
        <div>
          <div className="eyebrow"><span className="eyebrow-line" /> AI 学习程序</div>
          <h2>从目标，走到能交付的成果。</h2>
          <p>告诉 AI 想学什么；它会编排课程、陪你理解，并在每节课后检查你是否真的会用。</p>
        </div>
        {onBack && <button className="learning-back-button" onClick={onBack}><ArrowLeft size={16} /> 返回</button>}
      </header>

      <section className="learning-brief-card">
        <div className="learning-brief-copy">
          <span className="learning-brief-mark"><Sparkles size={17} /></span>
          <div><strong>从一件想学会的事开始</strong><p>课程不是资料清单。每一节都会留下一个能验证的输出。</p></div>
        </div>
        <button className="learning-starter-button" onClick={loadAgentStarter}><BookOpen size={15} /> 载入 Agent 实战示例</button>
        <div className="learning-form-grid">
          <label className="learning-field"><span>我想学习</span><input value={subject} onChange={(event) => setSubject(event.target.value)} maxLength={180} placeholder="例如：摄影、微积分、机器学习、法语口语" /></label>
          <label className="learning-field learning-field-hours"><span>每周投入</span><select value={weeklyHours} onChange={(event) => setWeeklyHours(Number(event.target.value))}><option value={2}>2 小时</option><option value={4}>4 小时</option><option value={6}>6 小时</option><option value={8}>8 小时</option></select></label>
          <label className="learning-field learning-field-wide"><span>课程结束时，我希望能做到</span><textarea value={goal} onChange={(event) => setGoal(event.target.value)} maxLength={500} placeholder="写下一个具体、可展示的结果" rows={2} /></label>
          <label className="learning-field learning-field-wide"><span>我现在的基础（可选）</span><input value={background} onChange={(event) => setBackground(event.target.value)} maxLength={500} placeholder="例如：看过一些教程，会基础编程" /></label>
        </div>
        <div className="learning-form-actions">
          <p>适用于技术、人文、语言、创作与职业技能等主题。</p>
          <button className="learning-generate-button" onClick={generateProgram} disabled={isGenerating}>{isGenerating ? <LoaderCircle className="spin" size={17} /> : <Sparkles size={17} />} {program ? "重新编排课程" : "生成我的课程"}<ArrowUpRight size={16} /></button>
        </div>
      </section>

      {error && <p className="learning-error" role="alert">{error}</p>}

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
                  return <button key={lesson.id} className={`learning-lesson-link ${isActive ? "is-active" : ""} ${isDone ? "is-done" : ""}`} onClick={() => chooseLesson(lesson)}>
                    <span className="learning-lesson-index">{isDone ? <Check size={13} /> : String(lesson.order).padStart(2, "0")}</span>
                    <span><small>{lesson.phase}</small><strong>{lesson.title}</strong><em>{lesson.durationMinutes} 分钟</em></span>
                    <ChevronRight size={15} />
                  </button>;
                })}
              </div>
            </aside>

            <article className="learning-lesson-card">
              <div className="learning-lesson-title-row">
                <div><span>第 {activeLesson.order} 节 · {activeLesson.phase}</span><h3>{activeLesson.title}</h3><p>{activeLesson.objective}</p></div>
                <button className={`learning-complete-button ${completedLessonIds.includes(activeLesson.id) ? "is-complete" : ""}`} onClick={() => toggleCompleted(activeLesson)}>{completedLessonIds.includes(activeLesson.id) ? <><Check size={15} /> 已学完</> : <><CircleCheck size={15} /> 标记学完</>}</button>
              </div>
              <div className="learning-concepts">{activeLesson.concepts.map((concept) => <span key={concept}>{concept}</span>)}</div>

              <div className="learning-lesson-content">
                <section><span className="learning-content-label"><Target size={14} /> 这一节先抓住</span><p>{activeLesson.opening}</p></section>
                <section><span className="learning-content-label"><BookOpen size={14} /> 导师讲解</span><p>{activeLesson.explanation}</p></section>
                <section className="learning-example"><span className="learning-content-label"><Sparkles size={14} /> 一个例子</span><p>{activeLesson.example}</p></section>
                <section className="learning-practice"><span className="learning-content-label"><PenLine size={14} /> 动手试试</span><p>{activeLesson.practice}</p><strong>本节交付物：{activeLesson.deliverable}</strong><div className="learning-practice-actions">{onAddLesson && <button onClick={() => onAddLesson(activeLesson)}>放进今日计划 <ArrowUpRight size={14} /></button>}</div></section>
              </div>

              <section className="learning-instructor-card">
                <div className="learning-instructor-avatar">岚</div>
                <div className="learning-instructor-copy"><span>{program.instructor.name}</span><strong>{program.instructor.role}</strong><p>{tutorReply?.lessonId === activeLesson.id ? tutorReply.reply : program.instructor.openingMessage}</p>{tutorReply?.lessonId === activeLesson.id && <small>{tutorReply.followUp}</small>}</div>
              </section>
              <div className="learning-tutor-composer"><MessageCircle size={16} /><input value={tutorInput} onChange={(event) => setTutorInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void askTutor(); }} maxLength={1200} placeholder="卡在哪、想让老师举什么例子？" /><button onClick={() => void askTutor()} disabled={isTutorBusy || !tutorInput.trim()} aria-label="向 AI 讲师提问">{isTutorBusy ? <LoaderCircle className="spin" size={17} /> : <Send size={17} />}</button></div>

              <section className="learning-quiz-block">
                <div className="learning-quiz-heading"><div><span>课后理解检查</span><h4>先答，再看反馈。</h4></div><button onClick={() => void gradeLesson()} disabled={isGrading}>{isGrading ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />}{grades[activeLesson.id] ? "重新评分" : "请老师评分"}</button></div>
                <div className="learning-question-list">
                  {activeLesson.questions.map((question, index) => <label className="learning-question" key={question.id}><span>{String(index + 1).padStart(2, "0")} · {question.kind}</span><strong>{question.prompt}</strong><small>{question.hint}</small><textarea value={answers[question.id] || ""} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))} placeholder="用自己的话写下理解，不需要写得很长。" rows={3} /></label>)}
                </div>
                {grades[activeLesson.id] && <GradeCard grade={grades[activeLesson.id]} questions={activeLesson.questions} />}
              </section>
            </article>
          </div>
        </section>
      )}

      {!program && <section className="learning-empty-course"><span><Sparkles size={18} /></span><div><strong>你的第一门课会从一个真实目标开始。</strong><p>推荐先加载上方的 Agent 实战示例，或直接写下任何你想系统学会的主题。</p></div></section>}
    </section>
  );
}

function GradeCard({ grade, questions }: { grade: CourseLessonGrade; questions: CourseLesson["questions"] }) {
  return <section className="learning-grade-card"><div className="learning-grade-score"><span>本节理解度</span><strong>{grade.score}</strong><em>/ 100</em></div><div className="learning-grade-summary"><strong>{grade.summary}</strong><p>下一步：{grade.nextStep}</p></div><div className="learning-grade-feedback">{grade.feedback.map((item, index) => <div key={item.questionId}><span>{questions[index]?.kind || "问题"} · {item.score} 分</span><p>{item.feedback}</p><small>评分关注：{item.reference}</small></div>)}</div><button className="learning-grade-reset" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}><RotateCcw size={14} /> 回到本节开头</button></section>;
}
