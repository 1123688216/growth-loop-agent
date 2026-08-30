"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowUpRight,
  BarChart3,
  BedDouble,
  Brain,
  BookOpen,
  CircleAlert,
  CircleCheck,
  CalendarDays,
  Check,
  ChevronRight,
  CircleHelp,
  Coffee,
  Dumbbell,
  Flame,
  Home as HomeIcon,
  LayoutDashboard,
  MessageCircle,
  MoreHorizontal,
  Pause,
  Plus,
  RotateCcw,
  Sparkles,
  Target,
  Timer,
  Trash2,
  Trophy,
  X,
} from "lucide-react";
import { demoSeed, type DemoSeed, type Goal, type Task, type TaskKind } from "@/lib/demo-data";
import { availableHours, minTargetDate, weeksUntil } from "@/lib/goal-schedule";
import { reviewBudget, type BudgetAllocation, type UserLearningProfile } from "@/lib/learning-budget";
import LearningProfileForm from "./learning-profile-form";
import type { QuizGrade, QuizQuestion } from "@/lib/agent/quiz";
import type { CourseLesson, CourseLessonGrade, DiagnosticAssessment, DiagnosticGrade, DiagnosticQuestionResult, GoalPreparation, LearningProgram } from "@/lib/learning-program/types";
import LearningStudio, { PROGRAM_STORAGE_KEY } from "./learning-studio";

type Tab = "今日" | "计划" | "课程" | "记录" | "成长";

type LogEntry = {
  id: string;
  text: string;
  topic: string;
  kind?: TaskKind;
  minutes?: number;
  output?: string;
  intent: "quick_log" | "plan_today" | "review";
  xp: number;
  coin: number;
  createdAt: string;
  mode: "llm" | "demo" | "pending";
  quizId?: string;
  quizScore?: number;
  quizRewarded?: boolean;
};

type QuizSession = {
  quizId: string;
  topic: string;
  sourceSummary: string;
  questions: QuizQuestion[];
  mode: "llm" | "demo";
  provider: string;
};

type PomodoroMode = "focus" | "break";
type TodayMode = "day" | "evening";
type CourseTarget = { taskId: string; lessonId?: string };
type CreateGoalInput = {
  title: string;
  description: string;
  targetDate: string;
  background: string;
  weeklyHours: number;
  selfLevel: "" | "beginner" | "familiar" | "intermediate";
};

type GoalCreationProgress = {
  stage: string;
  percent: number;
  message: string;
  status: "running" | "done" | "error";
};

type GoalCreationReporter = (progress: GoalCreationProgress) => void;

async function readGoalPreparationStream(response: Response, onProgress?: GoalCreationReporter): Promise<GoalPreparation> {
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(payload.error || "学习路径准备失败，请稍后重试。");
  }
  if (!response.body) throw new Error("浏览器没有收到学习路径进度流。");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let preparation: GoalPreparation | null = null;

  const consumeLine = (line: string) => {
    if (!line.trim()) return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new Error("学习路径进度流格式不正确。");
    }

    if (event.type === "progress" && event.progress && typeof event.progress === "object") {
      const progress = event.progress as Record<string, unknown>;
      if (typeof progress.stage === "string" && typeof progress.percent === "number" && typeof progress.message === "string") {
        onProgress?.({
          stage: progress.stage,
          percent: Math.max(0, Math.min(100, progress.percent)),
          message: progress.message,
          status: "running",
        });
      }
      return;
    }
    if (event.type === "error") throw new Error(typeof event.error === "string" ? event.error : "学习路径准备失败，请稍后重试。");
    if (event.type === "result" && event.preparation && typeof event.preparation === "object") {
      preparation = event.preparation as GoalPreparation;
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      lines.forEach(consumeLine);
      if (done) break;
    }
    consumeLine(buffer);
  } finally {
    reader.releaseLock();
  }

  if (!preparation) throw new Error("学习路径准备完成，但服务端没有返回结果。");
  return preparation;
}

type AdaptiveDiagnosticAnswerResult = {
  complete: boolean;
  assessment?: DiagnosticAssessment;
  questionResult?: DiagnosticQuestionResult;
  grade?: DiagnosticGrade;
  program?: LearningProgram;
  replayed?: boolean;
};

async function readDiagnosticAnswerStream(response: Response, onProgress?: GoalCreationReporter): Promise<AdaptiveDiagnosticAnswerResult> {
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(payload.error || "诊断评分失败，请稍后重试。");
  }
  if (!response.body) throw new Error("浏览器没有收到诊断评分进度流。");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: AdaptiveDiagnosticAnswerResult | null = null;
  const consumeLine = (line: string) => {
    if (!line.trim()) return;
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; }
    catch { throw new Error("诊断评分进度流格式不正确。"); }
    if (event.type === "progress" && event.progress && typeof event.progress === "object") {
      const progress = event.progress as Record<string, unknown>;
      if (typeof progress.stage === "string" && typeof progress.percent === "number" && typeof progress.message === "string") {
        onProgress?.({ stage: progress.stage, percent: Math.max(0, Math.min(100, progress.percent)), message: progress.message, status: "running" });
      }
      return;
    }
    if (event.type === "error") throw new Error(typeof event.error === "string" ? event.error : "诊断评分失败，请稍后重试。");
    if (event.type === "result" && event.result && typeof event.result === "object") result = event.result as AdaptiveDiagnosticAnswerResult;
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      lines.forEach(consumeLine);
      if (done) break;
    }
    consumeLine(buffer);
  } finally {
    reader.releaseLock();
  }
  if (!result) throw new Error("诊断评分完成，但服务端没有返回结果。");
  return result;
}

const REVIEW_STORAGE_KEY = "growth-loop.review-enabled.v1";
const POMODORO_FOCUS_SECONDS = 25 * 60;
const POMODORO_BREAK_SECONDS = 5 * 60;
const EVENING_REVIEW_HOUR = 21;
const EVENING_REVIEW_MINUTE = 30;
const tabs: Array<{ label: Tab; icon: typeof LayoutDashboard }> = [
  { label: "今日", icon: LayoutDashboard },
  { label: "计划", icon: CalendarDays },
  { label: "课程", icon: Brain },
  { label: "记录", icon: BookOpen },
  { label: "成长", icon: Trophy },
];

const tabCopy: Record<Tab, { eyebrow: string; suffix: string; description: string }> = {
  今日: { eyebrow: "今日回路", suffix: "只推进一件重要的事", description: "把注意力放在下一步，完成之后，进步自然会留下痕迹。" },
  计划: { eyebrow: "计划地图", suffix: "让长期目标落到今天", description: "目标不是另一张待办清单，它要能告诉你下一步为什么值得做。" },
  课程: { eyebrow: "AI 学习程序", suffix: "把目标变成可交付的能力", description: "从你想学会的一件事开始，AI 会编排课程、陪你理解，并用课后题检查迁移能力。" },
  记录: { eyebrow: "成长档案", suffix: "把事实留下来", description: "每一条记录都是以后判断进步时可以回看的证据。" },
  成长: { eyebrow: "成长仪表盘", suffix: "看见节奏，而不是给自己打分", description: "用近 7 天的行动和证据，找到下一轮最值得尝试的调整。" },
};

type DashboardUser = {
  username: string;
  displayName: string;
  actionStreakDays: number;
  level: number;
  role: string;
  focusScore: number;
};

export default function DashboardClient({ currentUser }: { currentUser: DashboardUser }) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<Tab>("今日");
  const [dashboard, setDashboard] = useState<DemoSeed>(() => ({
    ...demoSeed,
    user: {
      ...demoSeed.user,
      displayName: currentUser.displayName,
      streak: currentUser.actionStreakDays,
      level: currentUser.level,
      role: currentUser.role,
      focusScore: currentUser.focusScore,
      xpBalance: 0,
      coinBalance: 0,
    },
    goals: [],
    tasks: [],
    learningLogs: [],
    ledger: [],
    weeklyBars: demoSeed.weeklyBars.map((bar) => ({ ...bar, value: 0, label: "0m" })),
  }));
  const [tasks, setTasks] = useState<Task[]>([]);
  const [input, setInput] = useState("");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [pomodoroMode, setPomodoroMode] = useState<PomodoroMode>("focus");
  const [pomodoroSeconds, setPomodoroSeconds] = useState(POMODORO_FOCUS_SECONDS);
  const [isPomodoroRunning, setIsPomodoroRunning] = useState(false);
  const [showPomodoro, setShowPomodoro] = useState(false);
  const [isRemindersPaused, setIsRemindersPaused] = useState(false);
  const [reviewEnabled, setReviewEnabled] = useState(true);
  const [toast, setToast] = useState("");
  const [isAgentBusy, setIsAgentBusy] = useState(false);
  const [activeQuiz, setActiveQuiz] = useState<QuizSession | null>(null);
  const [isQuizOverlayOpen, setIsQuizOverlayOpen] = useState(false);
  const [quizAnswers, setQuizAnswers] = useState<Record<string, string>>({});
  const [quizGrade, setQuizGrade] = useState<QuizGrade | null>(null);
  const [quizBusy, setQuizBusy] = useState(false);
  const [quizSourceLogId, setQuizSourceLogId] = useState<string | null>(null);
  const [quizError, setQuizError] = useState("");
  const [currentHour, setCurrentHour] = useState<number | null>(null);
  const [todayModeOverride, setTodayModeOverride] = useState<TodayMode | null>(null);
  const [isQuickLogOpen, setIsQuickLogOpen] = useState(false);
  const [courseTarget, setCourseTarget] = useState<CourseTarget | null>(null);
  const [activeProgramId, setActiveProgramId] = useState("");
  const [budget, setBudget] = useState<{ hasProfile: boolean; profile: UserLearningProfile; allocations: BudgetAllocation[] } | null>(null);
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  const [showProfileForm, setShowProfileForm] = useState(false);
  const [pendingDiagnostic, setPendingDiagnostic] = useState<DiagnosticAssessment | null>(null);
  const [diagnosticQuestionIndex, setDiagnosticQuestionIndex] = useState(0);
  const [diagnosticAnswers, setDiagnosticAnswers] = useState<Record<string, string>>({});
  const [diagnosticGrade, setDiagnosticGrade] = useState<DiagnosticGrade | null>(null);
  const [diagnosticBusy, setDiagnosticBusy] = useState(false);
  const [diagnosticError, setDiagnosticError] = useState("");
  const [diagnosticProgress, setDiagnosticProgress] = useState<GoalCreationProgress | null>(null);
  const [diagnosticProgressEvents, setDiagnosticProgressEvents] = useState<GoalCreationProgress[]>([]);
  const [diagnosticQuestionResult, setDiagnosticQuestionResult] = useState<DiagnosticQuestionResult | null>(null);
  const quickLogRef = useRef<HTMLTextAreaElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reviewTimer = useRef<number | null>(null);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  useEffect(() => {
    const storedReviewPreference = window.localStorage.getItem(REVIEW_STORAGE_KEY);
    const reviewTimer = window.setTimeout(() => {
      if (storedReviewPreference !== null) setReviewEnabled(storedReviewPreference === "true");
    }, 0);
    return () => window.clearTimeout(reviewTimer);
  }, []);

  useEffect(() => {
    const syncHour = () => setCurrentHour(new Date().getHours());
    syncHour();
    const timer = window.setInterval(syncHour, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/learning-budget")
      .then(async (response) => response.ok ? await response.json() as { hasProfile: boolean; profile: UserLearningProfile; allocations: BudgetAllocation[] } : null)
      .then((result) => {
        if (!result || cancelled) return;
        setBudget(result);
        // 老用户和新用户都在这里补作息，注册表单不因此变重。
        setShowProfileForm(!result.hasProfile);
      })
      .catch(() => { /* 读不到预算不影响主流程，创建目标时会再提示 */ });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/dashboard")
      .then(async (response) => {
        if (response.status === 401) {
          router.push("/login");
          return null;
        }
        if (!response.ok) throw new Error("dashboard unavailable");
        return (await response.json()) as { data: DemoSeed };
      })
      .then((result) => {
        if (!result || cancelled) return;
        setDashboard(result.data);
        setTasks(result.data.tasks);
      })
      .catch(() => {
        if (!cancelled) notify("用户数据暂时无法读取，请稍后刷新");
      });
    return () => { cancelled = true; };
  }, [router]);

  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  useEffect(() => {
    if (!reviewEnabled) return;
    const scheduleNextReview = () => {
      const now = new Date();
      const nextReview = new Date(now);
      nextReview.setHours(EVENING_REVIEW_HOUR, EVENING_REVIEW_MINUTE, 0, 0);
      if (nextReview.getTime() <= now.getTime()) nextReview.setDate(nextReview.getDate() + 1);
      reviewTimer.current = window.setTimeout(() => {
        setInput((value) => value || "今晚回顾");
        setTodayModeOverride("evening");
        setActiveTab("今日");
        notify("21:30 晚间回顾已准备好");
        scheduleNextReview();
      }, Math.max(1_000, nextReview.getTime() - now.getTime()));
    };
    scheduleNextReview();
    return () => {
      if (reviewTimer.current) window.clearTimeout(reviewTimer.current);
    };
  }, [reviewEnabled]);

  useEffect(() => {
    if (!isPomodoroRunning) return;
    const timer = window.setInterval(() => {
      setPomodoroSeconds((seconds) => {
        if (seconds > 1) return seconds - 1;
        setIsPomodoroRunning(false);
        notify(pomodoroMode === "focus" ? "这一轮专注完成了，切换到 5 分钟恢复吧" : "恢复完成，准备开始下一轮专注吧");
        return pomodoroMode === "focus" ? POMODORO_BREAK_SECONDS : POMODORO_FOCUS_SECONDS;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [isPomodoroRunning, pomodoroMode]);

  function notify(message: string) {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 3_200);
  }

  function commitLogs(nextLogs: LogEntry[]) {
    setLogs(nextLogs);
  }

  function togglePomodoro() {
    setIsPomodoroRunning((running) => !running);
    notify(isPomodoroRunning ? "番茄钟已暂停，进度会保留" : `${pomodoroMode === "focus" ? "25 分钟专注" : "5 分钟恢复"}已开始`);
  }

  function resetPomodoro() {
    setIsPomodoroRunning(false);
    setPomodoroSeconds(pomodoroMode === "focus" ? POMODORO_FOCUS_SECONDS : POMODORO_BREAK_SECONDS);
    notify("番茄钟已重置");
  }

  function changePomodoroMode(mode: PomodoroMode) {
    setPomodoroMode(mode);
    setIsPomodoroRunning(false);
    setPomodoroSeconds(mode === "focus" ? POMODORO_FOCUS_SECONDS : POMODORO_BREAK_SECONDS);
  }

  const doneCount = tasks.filter((task) => task.status === "done").length;
  const automaticTodayMode: TodayMode = currentHour !== null && (currentHour >= 19 || currentHour < 5) ? "evening" : "day";
  const todayMode = todayModeOverride || automaticTodayMode;

  const greeting = useMemo(() => {
    if (doneCount === tasks.length) return "今天的回路已经闭合";
    if (doneCount > 0) return "很好，今天已经开始转起来了";
    return `早上好，${currentUser.displayName}`;
  }, [currentUser.displayName, doneCount, tasks.length]);

  async function generateQuiz(content: string, topic?: string, output?: string, sourceLogId?: string, openOverlay = false) {
    if (!content.trim()) return;
    setQuizBusy(true);
    setQuizError("");
    setQuizGrade(null);
    try {
      const response = await fetch("/api/quiz", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "generate", content, topic, output }),
      });
      if (!response.ok) throw new Error("quiz unavailable");
      const quiz = (await response.json()) as QuizSession;
      setActiveQuiz(quiz);
      setQuizAnswers({});
      setQuizSourceLogId(sourceLogId || null);
      setIsQuizOverlayOpen(openOverlay);
      notify(`已为「${quiz.topic}」生成 ${quiz.questions.length} 道理解题，写完再看分数`);
    } catch {
      setQuizError("题目生成失败了，可以稍后重试；学习记录不会丢失。");
    } finally {
      setQuizBusy(false);
    }
  }

  async function gradeQuiz() {
    if (!activeQuiz || quizBusy) return;
    setQuizBusy(true);
    setQuizError("");
    try {
      const response = await fetch("/api/quiz", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "grade",
          quizId: activeQuiz.quizId,
          topic: activeQuiz.topic,
          source: activeQuiz.sourceSummary,
          questions: activeQuiz.questions,
          answers: quizAnswers,
        }),
      });
      if (!response.ok) throw new Error("grade unavailable");
      const result = (await response.json()) as QuizGrade;
      setQuizGrade(result);
      if (quizSourceLogId) {
        const bonus = result.score >= 85 ? 10 : result.score >= 60 ? 6 : 3;
        commitLogs(logs.map((log) => {
          if (log.id !== quizSourceLogId) return log;
          if (log.quizRewarded) return { ...log, quizId: activeQuiz.quizId, quizScore: result.score };
          return { ...log, quizId: activeQuiz.quizId, quizScore: result.score, quizRewarded: true, xp: log.xp + bonus, coin: log.coin + Math.max(1, Math.round(bonus / 3)) };
        }));
      }
      notify(`理解测验完成：${result.score} 分，${result.level}`);
    } catch {
      setQuizError("评分暂时不可用，请检查连接后再试。");
    } finally {
      setQuizBusy(false);
    }
  }

  function resetQuiz() {
    setQuizGrade(null);
    setQuizAnswers({});
    setQuizError("");
  }

  function closeQuizOverlay() {
    setIsQuizOverlayOpen(false);
  }

  async function persistLog(message: string) {
    const isEveningReview = /^今晚回顾/.test(message);
    const reviewContext = isEveningReview
      ? logs.slice(0, 12).map((log) => `- ${log.topic || "今日记录"}：${log.text}`).join("\n")
      : undefined;
    const id = typeof window !== "undefined" && window.crypto?.randomUUID ? window.crypto.randomUUID() : `log-${Date.now()}`;
    const optimisticLog: LogEntry = {
      id,
      text: message,
      topic: "整理中…",
      intent: "quick_log",
      xp: 3,
      coin: 1,
      createdAt: "刚刚",
      mode: "pending",
    };
    commitLogs([optimisticLog, ...logs]);
    setInput("");
    setIsAgentBusy(true);
    notify("已保存，晚报时统一回顾");

    try {
      const response = await fetch("/api/activity-logs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, context: reviewContext }),
      });
      if (!response.ok) throw new Error("agent unavailable");
      const result = (await response.json()) as { reply?: string; log?: LogEntry; streak?: number };
      setLogs((current) => current.map((log) => log.id === id ? (result.log || { ...log, topic: message, mode: "demo" }) : log));
      if (typeof result.streak === "number") {
        const nextStreak = result.streak;
        setDashboard((current) => ({ ...current, user: { ...current.user, streak: nextStreak } }));
      }
    } catch {
      setLogs((current) => current.map((log) => log.id === id ? { ...log, topic: message || "学习记录", mode: "demo" } : log));
      notify("保存失败，请稍后重试");
    } finally {
      setIsAgentBusy(false);
    }
  }

  async function submitLog() {
    const message = input.trim();
    if (!message) return;
    setIsQuickLogOpen(false);
    await persistLog(message);
  }

  function focusQuickLog() {
    setIsQuickLogOpen(true);
    window.setTimeout(() => {
      quickLogRef.current?.focus();
    }, 80);
  }

  function toggleReviewSchedule() {
    const nextEnabled = !reviewEnabled;
    setReviewEnabled(nextEnabled);
    window.localStorage.setItem(REVIEW_STORAGE_KEY, String(nextEnabled));
    notify(nextEnabled ? "已开启每日 21:30 晚间回顾" : "已关闭晚间回顾提醒");
  }

  function startEveningReview() {
    setInput((value) => value || "今晚回顾" );
    setTodayModeOverride("evening");
    setActiveTab("今日");
    setIsQuickLogOpen(true);
    window.setTimeout(() => quickLogRef.current?.focus(), 80);
    notify("晚间回顾已准备好，写下今天最重要的一件事");
  }

  function openTaskCourse(task: Task) {
    setCourseTarget({ taskId: task.id, lessonId: task.lessonId });
    if (task.programId) setActiveProgramId(task.programId);
    setActiveTab("课程");
  }

  function handleLessonPassed(lesson: CourseLesson, grade: CourseLessonGrade) {
    const task = tasks.find((item) => item.lessonId === lesson.id) || tasks.find((item) => item.id === courseTarget?.taskId);
    // 服务端评分事务已经完成关联任务，这里只同步界面，不再发普通任务 PATCH。
    if (task && task.status !== "done") setTasks((current) => current.map((item) => item.id === task.id ? { ...item, status: "done" } : item));
    notify(`本节评测${grade.level}，今日任务已同步完成`);
  }

  function submitEveningClosure(answers: string[]) {
    const message = `今晚回顾：\n最重要的行动：${answers[0]}\n真正理解或应用：${answers[1]}\n明天的一步：${answers[2]}`;
    void persistLog(message);
  }

  async function saveLearningProfile(profile: UserLearningProfile) {
    setIsSavingProfile(true);
    try {
      const response = await fetch("/api/learning-budget", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(profile),
      });
      if (!response.ok) throw new Error("profile save failed");
      const result = await response.json() as { hasProfile: boolean; profile: UserLearningProfile; allocations: BudgetAllocation[] };
      setBudget(result);
      setShowProfileForm(false);
      notify("学习作息已保存，规划师会按它安排每日任务");
    } catch {
      notify("作息没有保存成功，请稍后重试");
    } finally {
      setIsSavingProfile(false);
    }
  }

  async function createGoal(value: CreateGoalInput, onProgress?: GoalCreationReporter) {
    let latestPercent = 0;
    const publishProgress = (progress: GoalCreationProgress) => {
      latestPercent = Math.max(latestPercent, progress.percent);
      onProgress?.({ ...progress, percent: latestPercent });
    };
    try {
      publishProgress({ stage: "save_goal", percent: 2, message: "正在保存目标和学习偏好", status: "running" });
      const response = await fetch("/api/goals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(value),
      });
      const result = (await response.json()) as { goal?: Goal; error?: string };
      if (!response.ok || !result.goal) throw new Error(result.error || "goal unavailable");
      const goal = result.goal;
      const createdGoal: Goal = {
        ...goal,
        selfLevel: value.selfLevel || undefined,
        diagnosticStatus: value.selfLevel === "beginner" ? "skipped" : "pending",
      };
      setDashboard((current) => ({ ...current, goals: [...current.goals, createdGoal] }));
      publishProgress({ stage: "save_goal", percent: 6, message: "目标已保存，正在启动学习工作流", status: "running" });

      try {
        // prepare-stream 会根据自评走诊断或课程分支，并返回真实节点进度。
        const courseResponse = await fetch("/api/learning-program", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "prepare-stream", goalId: goal.id }),
        });
        const preparation = await readGoalPreparationStream(courseResponse, publishProgress);
        if (preparation.nextAction === "diagnostic" && preparation.diagnostic) {
          publishProgress({ stage: "complete", percent: 100, message: "初始诊断已准备好，可以开始作答", status: "done" });
          setPendingDiagnostic(preparation.diagnostic);
          setDiagnosticQuestionIndex(Math.max(0, preparation.diagnostic.questions.length - 1));
          setDiagnosticAnswers({});
          setDiagnosticGrade(null);
          setDiagnosticError("");
          setDiagnosticQuestionResult(null);
          notify(`目标「${goal.title}」已创建，请先完成初始诊断`);
          return "diagnostic" as const;
        }
        const program = preparation.program;
        if (!program) throw new Error("course unavailable");
        publishProgress({ stage: "complete", percent: 100, message: "学习路径已准备完成", status: "done" });
        window.localStorage.setItem(PROGRAM_STORAGE_KEY, program.programId);
        setActiveProgramId(program.programId);
        setDashboard((current) => ({
          ...current,
          goals: current.goals.map((item) => item.id === goal.id ? { ...item, learningProgramId: program.programId } : item),
        }));
        setCourseTarget(null);
        notify(`目标「${goal.title}」已创建，课程也编排好了`);
        return "course" as const;
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : "请稍后重试";
        publishProgress({ stage: "error", percent: latestPercent, message, status: "error" });
        notify(`目标「${goal.title}」已创建，但学习路径准备失败：${message}`);
        return "goal" as const;
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "目标没有保存成功，请稍后重试";
      publishProgress({ stage: "error", percent: latestPercent, message, status: "error" });
      notify(message);
      return false as const;
    }
  }

  async function deleteLongTermGoal(goal: Goal) {
    try {
      const response = await fetch("/api/goals", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goalId: goal.id }),
      });
      const result = (await response.json()) as { deleted?: { deletedTaskIds?: string[] }; error?: string };
      if (!response.ok || !result.deleted) throw new Error(result.error || "目标删除失败。");
      const deletedTaskIds = new Set(result.deleted.deletedTaskIds || []);
      setDashboard((current) => ({ ...current, goals: current.goals.filter((item) => item.id !== goal.id) }));
      setTasks((current) => current.filter((task) => !deletedTaskIds.has(task.id) && task.id !== `goal-step-${goal.id}`));
      if (pendingDiagnostic?.goalId === goal.id) setPendingDiagnostic(null);
      if (goal.learningProgramId && activeProgramId === goal.learningProgramId) {
        setActiveProgramId("");
        if (window.localStorage.getItem(PROGRAM_STORAGE_KEY) === goal.learningProgramId) {
          window.localStorage.removeItem(PROGRAM_STORAGE_KEY);
        }
      }
      notify(`长期目标「${goal.title}」已删除`);
      return true;
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "目标删除失败，请稍后重试。");
      return false;
    }
  }

  async function submitDiagnostic() {
    if (!pendingDiagnostic || !diagnosticQuestion || diagnosticBusy) return;
    const answer = diagnosticAnswers[diagnosticQuestion.id]?.trim() || "";
    if (!answer) {
      setDiagnosticError("请先回答当前题目。不会也可以写出目前的判断。");
      return;
    }
    setDiagnosticBusy(true);
    setDiagnosticError("");
    setDiagnosticProgress({ stage: "start", percent: 2, message: "正在启动考官评分流程", status: "running" });
    setDiagnosticProgressEvents([]);
    try {
      const response = await fetch("/api/diagnostics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "answer-stream",
          assessmentId: pendingDiagnostic.id,
          questionId: diagnosticQuestion.id,
          answer,
        }),
      });
      const result = await readDiagnosticAnswerStream(response, (progress) => {
        setDiagnosticProgress(progress);
        setDiagnosticProgressEvents((current) => {
          const previous = current.at(-1);
          if (previous?.stage === progress.stage) return [...current.slice(0, -1), progress].slice(-5);
          return [...current, progress].slice(-5);
        });
      });
      if (result.questionResult) setDiagnosticQuestionResult(result.questionResult);
      if (!result.complete) {
        if (!result.assessment) throw new Error("下一题已经生成，但诊断状态无法读取。");
        setPendingDiagnostic(result.assessment);
        setDiagnosticQuestionIndex(Math.max(0, result.assessment.questions.length - 1));
        setDiagnosticAnswers({});
        const direction = result.questionResult?.direction === "harder" ? "难度已上调" : result.questionResult?.direction === "easier" ? "难度已下调" : "已切换到下一项能力";
        notify(`本题 ${result.questionResult?.score ?? 0}/10，${direction}`);
        return;
      }
      if (!result.grade || !result.program) throw new Error("诊断已结束，但课程结果无法读取。");
      setDiagnosticGrade(result.grade);
      window.localStorage.setItem(PROGRAM_STORAGE_KEY, result.program.programId);
      setActiveProgramId(result.program.programId);
      setDashboard((current) => ({
        ...current,
        goals: current.goals.map((item) => item.id === pendingDiagnostic.goalId
          ? { ...item, diagnosticStatus: "completed", learningProgramId: result.program!.programId }
          : item),
      }));
      setCourseTarget(null);
      notify(`初始诊断完成：${result.grade.score} 分，首节课程已生成`);
      window.setTimeout(() => {
        setPendingDiagnostic(null);
        setActiveTab("课程");
      }, 700);
    } catch (caught) {
      setDiagnosticError(caught instanceof Error ? caught.message : "诊断提交失败。");
    } finally {
      setDiagnosticBusy(false);
      setDiagnosticProgress(null);
      setDiagnosticProgressEvents([]);
    }
  }

  async function resumeGoal(goal: Goal) {
    try {
      const response = await fetch("/api/learning-program", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "prepare", goalId: goal.id }),
      });
      const result = (await response.json()) as { preparation?: GoalPreparation; error?: string };
      if (!response.ok || !result.preparation) throw new Error(result.error || "学习路径暂时不可用。");
      if (result.preparation.nextAction === "diagnostic" && result.preparation.diagnostic) {
        setPendingDiagnostic(result.preparation.diagnostic);
        setDiagnosticQuestionIndex(Math.max(0, result.preparation.diagnostic.questions.length - 1));
        setDiagnosticAnswers({});
        setDiagnosticGrade(null);
        setDiagnosticError("");
        setDiagnosticQuestionResult(null);
        return;
      }
      if (!result.preparation.program) throw new Error("课程暂时不可用。");
      window.localStorage.setItem(PROGRAM_STORAGE_KEY, result.preparation.program.programId);
      setActiveProgramId(result.preparation.program.programId);
      setCourseTarget(null);
      setActiveTab("课程");
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "学习路径暂时不可用。");
    }
  }

  function splitGoal(goal: Goal) {
    const taskId = `goal-step-${goal.id}`;
    const isAgentGoal = goal.id === "goal-ai-agent";
    setTasks((current) => current.some((task) => task.id === taskId) ? current : [
      ...current,
      {
        id: taskId,
        title: isAgentGoal ? "AI Agent 最小闭环：定义问题与验收" : `从「${goal.title}」拆一步`,
        subtitle: isAgentGoal ? "写出一个 Agent 要解决的问题，并定义一次可观察的成功结果" : "先完成一个 15 分钟可验证的小动作",
        time: isAgentGoal ? "今天" : "明天",
        duration: isAgentGoal ? "45 min" : "15 min",
        xp: isAgentGoal ? 20 : 5,
        coin: isAgentGoal ? 8 : 2,
        status: "upcoming",
        kind: "focus",
      },
    ]);
    notify(`已把「${goal.title}」拆成一个明天可执行的行动`);
  }

  async function addCourseLessonToToday(lesson: CourseLesson) {
    if (tasks.some((task) => task.lessonId === lesson.id)) {
      notify(`「${lesson.title}」已经在今日计划中`);
      return;
    }
    try {
      // 任务标题、时长和合格线由服务端按 lessonId 取自课程本身，并写入 task_lesson_links。
      const response = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lessonId: lesson.id }),
      });
      const result = (await response.json()) as { task?: { id: string }; error?: string };
      if (!response.ok || !result.task) throw new Error(result.error || "task create unavailable");
      const taskId = result.task.id;
      setTasks((current) => current.some((task) => task.id === taskId) ? current : [
        ...current,
        {
          id: taskId,
          title: `课程 · ${lesson.title}`,
          subtitle: lesson.deliverable,
          time: "今天",
          duration: `${lesson.durationMinutes} min`,
          xp: 18,
          coin: 6,
          status: "upcoming",
          kind: "learn",
          lessonId: lesson.id,
          programId: activeProgramId || undefined,
        },
      ]);
      notify(`已把「${lesson.title}」放进今日计划`);
    } catch {
      notify("课程没有加入今日计划，请稍后重试");
    }
  }

  const diagnosticQuestion = pendingDiagnostic?.questions[diagnosticQuestionIndex];
  const diagnosticQuestionCount = pendingDiagnostic?.maxQuestions || pendingDiagnostic?.questions.length || 0;
  const diagnosticAnsweredCount = pendingDiagnostic?.answeredCount || 0;
  const diagnosticStepPercent = diagnosticQuestionCount
    ? Math.round(((diagnosticAnsweredCount + 1) / diagnosticQuestionCount) * 100)
    : 0;

  return (
    <main className={`app-shell ${activeTab === "今日" ? "home-shell" : ""}`}>
      <aside className="sidebar" aria-label="主导航">
        <div className="brand-lockup">
          <div className="brand-mark"><Sparkles size={16} strokeWidth={2.4} /></div>
          <div>
            <div className="brand-name">成长回路</div>
            <div className="brand-subtitle">GROWTH LOOP</div>
          </div>
        </div>

        <div className="sidebar-label">工作台</div>
        <nav className="side-nav">
          {tabs.map(({ label, icon: Icon }) => (
            <button key={label} className={`side-nav-item ${activeTab === label ? "active" : ""}`} onClick={() => setActiveTab(label)}>
              <Icon size={18} />
              <span>{label}</span>
              {label === "今日" && <span className="nav-dot" aria-label="有今日任务" />}
            </button>
          ))}
        </nav>

        <div className="sidebar-label sidebar-label-spaced">本周状态</div>
        <div className="mini-streak">
          <div className="mini-streak-icon"><Flame size={17} /></div>
          <div>
            <strong>{currentUser.actionStreakDays} 天</strong>
            <span>连续有效行动</span>
          </div>
          <ChevronRight size={15} className="muted-icon" />
        </div>

        <div className="sidebar-bottom">
          <button className="help-link" onClick={() => notify("小贴士：把下一步缩小到 10 分钟，先留下事实，晚报时再补充结果。")}><CircleHelp size={16} /> 使用小贴士</button>
          <div className="profile-chip">
            <div className="avatar">{currentUser.displayName.slice(0, 1)}</div>
            <div className="profile-meta"><strong>{currentUser.displayName}</strong><span>Lv. {String(currentUser.level).padStart(2, "0")} · {currentUser.role}</span></div>
            <button className="profile-menu-button" type="button" aria-label="退出登录" title="退出登录" onClick={logout}><MoreHorizontal size={16} /></button>
          </div>
        </div>
      </aside>

      <section className="main-column">
        <header className="topbar">
          <div className="mobile-brand"><div className="brand-mark"><Sparkles size={15} /></div><span>成长回路</span></div>
          <div className="date-stamp">{dashboard.user.dateLabel} <span>·</span> {dashboard.user.weekdayLabel}</div>
          <div className="topbar-actions"><span className="ai-online-pill"><span /> AI 在线</span><button className="icon-button" aria-label="打开消息" onClick={() => notify(reviewEnabled ? "下一次 AI 晚间回顾：今天 21:30" : "晚间回顾目前已关闭") }><MessageCircle size={18} /></button><button className="avatar avatar-small avatar-button" type="button" aria-label={`退出 ${currentUser.username}`} title="退出登录" onClick={logout}>{currentUser.displayName.slice(0, 1)}</button></div>
        </header>

        <div className="content-wrap">
          {activeTab !== "今日" && <section className="hero-row">
            <div>
              <div className="eyebrow"><span className="eyebrow-line" /> {tabCopy[activeTab].eyebrow} <span className="eyebrow-muted">/ {tabCopy[activeTab].suffix}</span></div>
              <h1>{tabCopy[activeTab].eyebrow}</h1>
              <p className="hero-copy">{tabCopy[activeTab].description}</p>
            </div>
            <div className="hero-actions"><button className="quiet-button" aria-pressed={isRemindersPaused} onClick={() => { setIsRemindersPaused((paused) => !paused); notify(isRemindersPaused ? "提醒已恢复" : "提醒已暂停，今天不会主动打扰你"); }}><Pause size={15} /> {isRemindersPaused ? "恢复提醒" : "暂停提醒"}</button><button className="primary-button" onClick={focusQuickLog}><Plus size={16} /> 随手一记</button></div>
          </section>}

          {activeTab === "今日" ? (
            <TodayHome
              greeting={greeting}
              tasks={tasks}
              doneCount={doneCount}
              mode={todayMode}
              onSetMode={setTodayModeOverride}
              onOpenQuickLog={focusQuickLog}
              onOpenCourse={openTaskCourse}
              onSubmitReview={submitEveningClosure}
              onOpenPlan={() => setActiveTab("计划")}
              reviewEnabled={reviewEnabled}
              onToggleReview={toggleReviewSchedule}
              onStartReview={startEveningReview}
              pomodoroVisible={showPomodoro}
              onTogglePomodoro={() => setShowPomodoro((visible) => !visible)}
              pomodoro={<PomodoroWidget mode={pomodoroMode} seconds={pomodoroSeconds} isRunning={isPomodoroRunning} onToggle={togglePomodoro} onReset={resetPomodoro} onModeChange={changePomodoroMode} />}
            />
          ) : activeTab === "计划" ? (
            <PlanPanel dashboard={dashboard} tasks={tasks} onSplitGoal={splitGoal} onResumeGoal={resumeGoal} onCreateGoal={createGoal} onDeleteGoal={deleteLongTermGoal} onOpenCourse={() => setActiveTab("课程")} budget={budget} onEditBudget={() => setShowProfileForm(true)} />
          ) : activeTab === "课程" ? (
            <LearningStudio goals={dashboard.goals} onSelectGoal={resumeGoal} onBack={() => setActiveTab("计划")} onAddLesson={addCourseLessonToToday} programId={activeProgramId} targetLessonId={courseTarget?.lessonId} onLessonPassed={handleLessonPassed} />
          ) : activeTab === "记录" ? (
            <RecordsPanel dashboard={dashboard} logs={logs} onOpenQuickLog={focusQuickLog} onGenerateQuiz={(log) => generateQuiz(log.text, log.topic, log.output, log.id, true)} />
          ) : (
            <GrowthPanel dashboard={dashboard} />
          )}
        </div>
        <div className="mobile-nav">{tabs.map(({ label, icon: Icon }) => <button key={label} className={activeTab === label ? "active" : ""} onClick={() => setActiveTab(label)} aria-current={activeTab === label ? "page" : undefined}><Icon size={18} /><span>{label}</span></button>)}</div>
      </section>

      {isQuickLogOpen && <div className="quick-log-overlay" role="dialog" aria-modal="true" aria-label="随手一记">
        <button className="quick-log-backdrop" aria-label="关闭随手一记" onClick={() => setIsQuickLogOpen(false)} />
        <section className="quick-log-dialog">
          <div className="quick-log-heading"><div><span className="eyebrow">QUICK NOTE</span><h2>随手一记</h2><p>先把发生的事留下来，不需要现在分类或整理。</p></div><button className="quiz-close-button" onClick={() => setIsQuickLogOpen(false)}><X size={15} /> 关闭</button></div>
          <textarea ref={quickLogRef} value={input} onChange={(event) => setInput(event.target.value)} maxLength={480} rows={7} placeholder="例如：今天看懂了 Agent 的工具调用，也发现自己对状态管理还不熟……" />
          <div className="quick-log-actions"><span>{input.length}/480 · 晚间统一回顾</span><button className="primary-button" onClick={() => void submitLog()} disabled={!input.trim() || isAgentBusy}>{isAgentBusy ? "正在保存" : "保存记录"}<ArrowUpRight size={15} /></button></div>
        </section>
      </div>}

      {activeQuiz && isQuizOverlayOpen && <div className="quiz-overlay" role="dialog" aria-modal="true" aria-label={`理解测验：${activeQuiz.topic}`}>
        <button className="quiz-overlay-backdrop" aria-label="关闭理解测验" onClick={closeQuizOverlay} />
        <div className="quiz-overlay-dialog">
          <div className="quiz-overlay-toolbar"><span>正在专注：理解测验</span><button className="quiz-close-button" onClick={closeQuizOverlay}><X size={15} /> 关闭</button></div>
          <LearningQuizCard quiz={activeQuiz} answers={quizAnswers} grade={quizGrade} busy={quizBusy} error={quizError} onAnswer={(id, value) => setQuizAnswers((answers) => ({ ...answers, [id]: value }))} onGrade={gradeQuiz} onReset={resetQuiz} />
        </div>
      </div>}

      {pendingDiagnostic && diagnosticQuestion && <div className="quiz-overlay diagnostic-overlay" role="dialog" aria-modal="true" aria-label={`自适应初始诊断，第 ${diagnosticAnsweredCount + 1} 题，最多 ${diagnosticQuestionCount} 题`}>
        <button className="quiz-overlay-backdrop" aria-label="稍后继续诊断" onClick={() => setPendingDiagnostic(null)} />
        <div className="quiz-overlay-dialog diagnostic-dialog">
          <div className="quiz-overlay-toolbar"><span>自适应诊断 · 已完成 {diagnosticAnsweredCount} 题 · 最多 {diagnosticQuestionCount} 题</span><button className="quiz-close-button" onClick={() => setPendingDiagnostic(null)}><X size={15} /> 稍后继续</button></div>
          <section className="diagnostic-card">
            <div className="diagnostic-heading"><span className="eyebrow">ADAPTIVE BASELINE CHECK</span><h2>逐题寻找你的能力边界</h2><p>每次提交后立即评分：证据充分就提高难度，证据不足就降低难度或换基础题；上下界收敛后会提前结束。</p></div>
            <div className="diagnostic-step-heading"><span>第 {String(diagnosticAnsweredCount + 1).padStart(2, "0")} 题 / 最多 {String(diagnosticQuestionCount).padStart(2, "0")} 题</span><strong>{diagnosticStepPercent}%</strong></div>
            <div className="diagnostic-step-track" role="progressbar" aria-label="初始诊断答题进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={diagnosticStepPercent}><span style={{ width: `${diagnosticStepPercent}%` }} /></div>
            {diagnosticQuestionResult && <div className={`diagnostic-adaptive-feedback is-${diagnosticQuestionResult.direction}`}><strong>上一题 {diagnosticQuestionResult.score}/{diagnosticQuestionResult.maxScore}</strong><span>{diagnosticQuestionResult.feedback}</span><em>{diagnosticQuestionResult.direction === "harder" ? "难度上调" : diagnosticQuestionResult.direction === "easier" ? "难度下调" : "切换能力继续确认"}</em></div>}
            <label className="learning-question diagnostic-question-card" key={diagnosticQuestion.id}>
              <span>难度 {diagnosticQuestion.difficulty}</span>
              <strong>{diagnosticQuestion.prompt}</strong>
              <small>{diagnosticQuestion.hint}</small>
              <textarea autoFocus value={diagnosticAnswers[diagnosticQuestion.id] || ""} onChange={(event) => setDiagnosticAnswers((current) => ({ ...current, [diagnosticQuestion.id]: event.target.value }))} rows={6} placeholder="写下你的判断、依据和验证方式。" />
            </label>
            {diagnosticError && <p className="learning-error" role="alert">{diagnosticError}</p>}
            {diagnosticGrade && <div className="diagnostic-result"><strong>{diagnosticGrade.score} 分 · {diagnosticGrade.level}</strong><span>{diagnosticGrade.summary}</span></div>}
            <div className="diagnostic-navigation"><span>提交后将锁定本题证据，并据此生成下一题</span><button className="primary-button" type="button" onClick={() => void submitDiagnostic()} disabled={diagnosticBusy || !diagnosticAnswers[diagnosticQuestion.id]?.trim()}>提交本题并自适应出题<ArrowUpRight size={15} /></button></div>
          </section>
        </div>
      </div>}

      {diagnosticBusy && diagnosticProgress && <div className="quick-log-overlay diagnostic-scoring-overlay" role="dialog" aria-modal="true" aria-label="考官正在评分">
        <div className="quick-log-backdrop" />
        <section className="quick-log-dialog goal-progress-dialog diagnostic-scoring-dialog" aria-busy="true" aria-live="polite">
          <div className="goal-progress-animation" aria-hidden="true"><div className="goal-progress-orbit"><i /><i /><i /></div><span><Brain size={21} /></span></div>
          <div className="goal-progress-dialog-heading"><span className="eyebrow">EXAMINER WORKFLOW</span><h2>考官正在评估本题</h2><p>{diagnosticProgress.message}</p></div>
          <div className="goal-creation-progress-heading"><strong>实际执行进度</strong><em>{diagnosticProgress.percent}%</em></div>
          <div className="goal-creation-progress-track" role="progressbar" aria-label="考官评分进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={diagnosticProgress.percent}><span style={{ width: `${diagnosticProgress.percent}%` }} /></div>
          <div className="goal-creation-progress-events">{diagnosticProgressEvents.map((event, index) => <div className={index === diagnosticProgressEvents.length - 1 ? "is-current" : "is-finished"} key={`${event.stage}-${index}`}><span className="goal-creation-event-icon">{index < diagnosticProgressEvents.length - 1 ? <Check size={11} /> : <i />}</span><span>{event.message}</span><em>{event.percent}%</em></div>)}</div>
          <div className="goal-progress-dialog-footer"><span>只展示评分节点与产物，不展示模型内部推理原文。</span></div>
        </section>
      </div>}

      {showProfileForm && budget && <div className="quick-log-overlay" role="dialog" aria-modal="true" aria-label="学习作息">
        <button className="quick-log-backdrop" aria-label="关闭" onClick={() => setShowProfileForm(false)} />
        <LearningProfileForm
          initial={budget.profile}
          saving={isSavingProfile}
          onSave={(profile) => void saveLearningProfile(profile)}
          onSkip={budget.hasProfile ? () => setShowProfileForm(false) : undefined}
          title={budget.hasProfile ? "调整学习作息" : "先说说你一周能学多久"}
          description={budget.hasProfile
            ? "改动会影响每周预算和跨目标的时间校验。"
            : "创建目标时会从这份预算里分配时间，也用来判断安排得开不开。"}
        />
      </div>}

      {toast && <div className="toast" role="status" aria-live="polite"><span className="toast-status" /> {toast}</div>}
    </main>
  );
}

function formatTimer(seconds: number) {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, "0");
  const remainder = (seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remainder}`;
}

type TodayHomeProps = {
  greeting: string;
  tasks: Task[];
  doneCount: number;
  mode: TodayMode;
  onSetMode: (mode: TodayMode) => void;
  onOpenQuickLog: () => void;
  onOpenCourse: (task: Task) => void;
  onSubmitReview: (answers: string[]) => void;
  onOpenPlan: () => void;
  reviewEnabled: boolean;
  onToggleReview: () => void;
  onStartReview: () => void;
  pomodoroVisible: boolean;
  onTogglePomodoro: () => void;
  pomodoro: React.ReactNode;
};

function TodayHome({ greeting, tasks, doneCount, mode, onSetMode, onOpenQuickLog, onOpenCourse, onSubmitReview, onOpenPlan, reviewEnabled, onToggleReview, onStartReview, pomodoroVisible, onTogglePomodoro, pomodoro }: TodayHomeProps) {
  const visibleTasks = tasks.slice(0, 4);
  const [reviewAnswers, setReviewAnswers] = useState(["", "", ""]);
  const completion = tasks.length ? Math.round((doneCount / tasks.length) * 100) : 0;
  const remainingMinutes = tasks.filter((task) => task.status !== "done").reduce((total, task) => total + (Number.parseInt(task.duration, 10) || 0), 0);
  const currentTask = tasks.find((task) => task.status !== "done");

  function submitReview() {
    if (reviewAnswers.some((answer) => !answer.trim())) return;
    onSubmitReview(reviewAnswers.map((answer) => answer.trim()));
    setReviewAnswers(["", "", ""]);
  }

  return <div className="home-command-center">
    <section className="home-intro">
      <div>
        <div className="eyebrow"><span className="eyebrow-line" /> {mode === "day" ? "DAY MODE" : "EVENING MODE"} <span className="eyebrow-muted">/ {mode === "day" ? "今天只推进下一步" : "把今天收束成明天能用的经验"}</span></div>
        <h1>{greeting}</h1>
        <p className="home-intro-copy">{mode === "day" ? "先完成今天真正重要的事，需要时再随手留下一笔。" : "看看今天完成了什么，再用三个问题结束这一天。"}</p>
      </div>
      <div className="today-mode-switch" aria-label="切换今日时段"><button className={mode === "day" ? "active" : ""} onClick={() => onSetMode("day")}>白天</button><button className={mode === "evening" ? "active" : ""} onClick={() => onSetMode("evening")}>晚上</button></div>
    </section>

    <section className="progress-card today-progress-card" aria-label="今日完成情况">
      <div className="progress-ring" style={{ background: `conic-gradient(var(--coral) ${completion * 3.6}deg, #36515f 0deg)` }}><div><strong>{doneCount}/{tasks.length}</strong><span>今日行动</span></div></div>
      <div className="progress-card-copy">
        <span className="card-kicker">{mode === "day" ? "CURRENT FOCUS" : "TODAY SUMMARY"}</span>
        <h2>{mode === "day" ? (currentTask?.title || "今天的任务已经完成") : `今天完成了 ${doneCount} 项任务`}</h2>
        <p>{mode === "day" ? (currentTask?.subtitle || "可以安心结束今天，或进入晚间回顾。") : (doneCount === tasks.length ? "今天的行动已经全部闭环。" : `还有 ${tasks.length - doneCount} 项没有完成，可以顺延到明天。`)}</p>
        <div className="progress-track"><span style={{ width: `${completion}%` }} /></div>
      </div>
      <div className="progress-card-meta"><span>{mode === "day" ? "预计剩余" : "完成率"}</span><strong>{mode === "day" ? `${remainingMinutes}m` : `${completion}%`}</strong></div>
    </section>

    {mode === "day" ? <section className="home-agenda-grid is-day">
      <div className="home-agenda-card">
        <div className="home-section-head"><div><span className="eyebrow">TODAY ACTIONS</span><h2>今天要做的事</h2></div><div className="home-section-actions"><button className="text-button" onClick={onOpenPlan}>调整顺序</button><button className="quick-note-button" onClick={onOpenQuickLog}><Plus size={14} /> 随手一记</button></div></div>
        <div className="home-agenda-list">{visibleTasks.map((task) => <HomeAgendaRow key={task.id} task={task} onOpenCourse={onOpenCourse} />)}</div>
        {tasks.length === 0 && <div className="home-empty-state"><strong>今天还没有任务</strong><p>先在计划页创建目标，或从课程中加入一节课。</p></div>}
        <div className="home-agenda-footer"><button className="home-more-button" onClick={onOpenPlan}>查看完整计划 <ChevronRight size={15} /></button><button className="home-focus-link" onClick={onTogglePomodoro}><Timer size={14} />{pomodoroVisible ? "收起专注工具" : "需要节奏？打开 25 分钟"}</button></div>
        {pomodoroVisible && <div className="home-pomodoro-slot">{pomodoro}</div>}
      </div>
    </section> : <section className="evening-closure-card">
      <div className="home-section-head"><div><span className="eyebrow">DAILY CLOSURE</span><h2>每日收束</h2><p>三句话就够了。AI 会把答案与今天的记录放在一起。</p></div><button className={`review-toggle ${reviewEnabled ? "is-enabled" : ""}`} aria-pressed={reviewEnabled} onClick={onToggleReview}><span />{reviewEnabled ? "21:30 已开启" : "提醒已关闭"}</button></div>
      <div className="closure-question-list">
        {["今天最重要的行动是什么？", "今天真正理解或应用了什么？", "明天最小的一步是什么？"].map((question, index) => <label className="closure-question" key={question}><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{question}</strong><textarea rows={2} maxLength={100} value={reviewAnswers[index]} onChange={(event) => setReviewAnswers((current) => current.map((answer, answerIndex) => answerIndex === index ? event.target.value : answer))} placeholder="用一句自己的话回答……" /></div></label>)}
      </div>
      <div className="closure-actions"><button className="quiet-button" onClick={onStartReview}>使用 AI 引导</button><button className="primary-button" onClick={submitReview} disabled={reviewAnswers.some((answer) => !answer.trim())}>完成今日收束 <ArrowUpRight size={15} /></button></div>
    </section>}
  </div>;
}

function HomeAgendaRow({ task, onOpenCourse }: { task: Task; onOpenCourse: (task: Task) => void }) {
  return <button className={`home-agenda-row ${task.status === "done" ? "is-done" : task.status === "current" ? "is-current" : ""}`} onClick={() => onOpenCourse(task)}>
    <div className="home-agenda-time"><strong>{task.time}</strong><span>{task.duration}</span></div>
    <div className={`home-agenda-kind kind-${task.kind}`}>{renderTaskKindIcon(task.kind, 15)}</div>
    <div className="home-agenda-copy"><div><strong>{task.title}</strong><span className={`home-kind-label kind-${task.kind}`}>{task.status === "done" ? "已完成" : "进入课程"}</span></div><p>{task.subtitle}</p><small>{task.status === "done" ? "评测已通过" : "点击进入对应课程，答题合格后完成"}</small></div>
    <span className="home-agenda-arrow"><ArrowUpRight size={15} /></span>
  </button>;
}

function PomodoroWidget({ mode, seconds, isRunning, onToggle, onReset, onModeChange }: { mode: PomodoroMode; seconds: number; isRunning: boolean; onToggle: () => void; onReset: () => void; onModeChange: (mode: PomodoroMode) => void }) {
  const totalSeconds = mode === "focus" ? POMODORO_FOCUS_SECONDS : POMODORO_BREAK_SECONDS;
  const progress = Math.min(100, Math.round(((totalSeconds - seconds) / totalSeconds) * 100));
  return <section className={`pomodoro-widget ${mode === "break" ? "is-break" : ""}`} aria-label="可选番茄钟">
    <div className="pomodoro-icon">{mode === "focus" ? <Timer size={18} /> : <Coffee size={18} />}</div>
    <div className="pomodoro-copy"><div className="pomodoro-label"><span className="eyebrow">OPTIONAL POMODORO</span><span>可选，不打断计划</span></div><strong>{mode === "focus" ? "25 分钟专注" : "5 分钟恢复"}</strong><p>{mode === "focus" ? "只做当前行动的一小段，结束后再决定下一步。" : "离开屏幕、喝水或走动，让注意力重新充电。"}</p><div className="pomodoro-track"><span style={{ width: `${progress}%` }} /></div></div>
    <div className="pomodoro-clock"><strong>{formatTimer(seconds)}</strong><div className="pomodoro-controls"><button className="pomodoro-start" onClick={onToggle}>{isRunning ? "暂停" : "开始"}</button><button className="pomodoro-reset" onClick={onReset} aria-label="重置番茄钟"><RotateCcw size={13} /></button></div><div className="pomodoro-modes"><button className={mode === "focus" ? "active" : ""} aria-pressed={mode === "focus"} onClick={() => onModeChange("focus")}>专注</button><button className={mode === "break" ? "active" : ""} aria-pressed={mode === "break"} onClick={() => onModeChange("break")}>休息</button></div></div>
  </section>;
}

function taskKindLabel(kind: TaskKind) {
  return ({ focus: "专注", learn: "学习", exercise: "运动", life: "生活", rest: "休息" })[kind];
}

function renderTaskKindIcon(kind: TaskKind, size: number) {
  if (kind === "learn") return <BookOpen size={size} />;
  if (kind === "exercise") return <Dumbbell size={size} />;
  if (kind === "life") return <HomeIcon size={size} />;
  if (kind === "rest") return <BedDouble size={size} />;
  return <Target size={size} />;
}

const EMPTY_GOAL_DRAFT: CreateGoalInput = { title: "", description: "", targetDate: "", background: "", weeklyHours: 4, selfLevel: "" };

function PlanPanel({ dashboard, tasks, onSplitGoal, onResumeGoal, onCreateGoal, onDeleteGoal, onOpenCourse, budget, onEditBudget }: { dashboard: DemoSeed; tasks: Task[]; onSplitGoal: (goal: Goal) => void; onResumeGoal: (goal: Goal) => Promise<void>; onCreateGoal: (value: CreateGoalInput, onProgress?: GoalCreationReporter) => Promise<false | "goal" | "course" | "diagnostic">; onDeleteGoal: (goal: Goal) => Promise<boolean>; onOpenCourse: () => void; budget: { hasProfile: boolean; profile: UserLearningProfile; allocations: BudgetAllocation[] } | null; onEditBudget: () => void }) {
  const [view, setView] = useState<"week" | "long">("week");
  const [showCreateGoal, setShowCreateGoal] = useState(false);
  const [goalDraft, setGoalDraft] = useState<CreateGoalInput>(EMPTY_GOAL_DRAFT);
  const [isCreating, setIsCreating] = useState(false);
  const [creationProgress, setCreationProgress] = useState<GoalCreationProgress | null>(null);
  const [creationEvents, setCreationEvents] = useState<GoalCreationProgress[]>([]);
  const [goalToDelete, setGoalToDelete] = useState<Goal | null>(null);
  const [isDeletingGoal, setIsDeletingGoal] = useState(false);
  const completed = tasks.filter((task) => task.status === "done").length;
  const plannedWeeks = weeksUntil(goalDraft.targetDate || null);
  const plannedHours = availableHours(goalDraft.targetDate || null, goalDraft.weeklyHours);
  // 跨目标总量在填表时就实时算，而不是创建完再告诉用户超了。
  // reviewBudget 是纯函数，客户端和服务端用同一份逻辑。
  const budgetReview = budget?.hasProfile
    ? reviewBudget({
      profile: budget.profile,
      allocations: budget.allocations,
      incoming: { title: goalDraft.title || "这个目标", weeklyMinutes: goalDraft.weeklyHours * 60 },
    })
    : null;
  const showCreationProgress = isCreating || creationProgress?.status === "error";
  const visibleCreationProgress: GoalCreationProgress = creationProgress || {
    stage: "starting",
    percent: 0,
    message: "正在启动学习工作流",
    status: "running",
  };

  async function submitGoal() {
    if (!goalDraft.title.trim()) return;
    setIsCreating(true);
    setCreationProgress(null);
    setCreationEvents([]);
    const created = await onCreateGoal(
      { ...goalDraft, title: goalDraft.title.trim(), description: goalDraft.description.trim(), background: goalDraft.background.trim() },
      (progress) => {
        setCreationProgress(progress);
        setCreationEvents((current) => {
          const previous = current.at(-1);
          if (previous?.stage === progress.stage) return [...current.slice(0, -1), progress].slice(-5);
          return [...current, progress].slice(-5);
        });
      },
    );
    setIsCreating(false);
    if (!created) return;
    setShowCreateGoal(false);
    setGoalDraft(EMPTY_GOAL_DRAFT);
    if (created === "course") onOpenCourse();
    else setView("long");
  }

  function openCreateGoal() {
    setCreationProgress(null);
    setCreationEvents([]);
    setShowCreateGoal(true);
  }

  async function confirmDeleteGoal() {
    if (!goalToDelete || isDeletingGoal) return;
    setIsDeletingGoal(true);
    const deleted = await onDeleteGoal(goalToDelete);
    setIsDeletingGoal(false);
    if (deleted) setGoalToDelete(null);
  }

  return <div className="workspace-page">
    <div className="plan-view-toolbar"><div className="plan-view-switch"><button className={view === "week" ? "active" : ""} onClick={() => setView("week")}>本周任务</button><button className={view === "long" ? "active" : ""} onClick={() => setView("long")}>长期任务</button></div><button className="primary-button" onClick={openCreateGoal}><Plus size={15} /> 创建目标</button></div>

    {view === "week" ? <section className="panel plan-timeline-panel"><div className="panel-heading"><div><span className="eyebrow">WEEK TIMELINE</span><h2>本周任务时间线</h2></div><span className="count-badge">{completed}/{tasks.length} 已完成</span></div><p className="panel-desc">任务完成状态由对应课程的课后评测同步，计划页只负责看路径。</p><div className="plan-timeline">
      {tasks.map((task, index) => <article className={`plan-timeline-item ${task.status === "done" ? "is-done" : ""}`} key={task.id}><div className="plan-timeline-marker"><span>{task.status === "done" ? <Check size={13} /> : String(index + 1).padStart(2, "0")}</span></div><div className="plan-timeline-copy"><span>{task.time} · {task.duration}</span><strong>{task.title}</strong><p>{task.subtitle}</p></div><em>{task.status === "done" ? "已完成" : task.status === "current" ? "进行中" : "待开始"}</em></article>)}
      {tasks.length === 0 && <div className="records-empty"><strong>本周还没有任务</strong><p>创建长期目标后拆出下一步，或从课程中加入一节课。</p></div>}
    </div></section> : <section className="long-goals-section"><div className="goal-grid">
      {dashboard.goals.map((goal) => <article className="goal-card" key={goal.id}><div className="goal-card-top"><span className="goal-status">{goal.diagnosticStatus === "pending" || goal.diagnosticStatus === "in_progress" ? "待初始诊断" : goal.status}</span><span className="goal-horizon">{goal.horizon}</span></div><h3>{goal.title}</h3><p>{goal.description}</p><div className="goal-progress-row"><span>当前进度</span><strong>{goal.progress}%</strong></div><div className="goal-progress"><span style={{ width: `${goal.progress}%` }} /></div><div className="goal-footer"><span><Target size={13} /> 长期目标</span><div className="goal-footer-actions"><button className="goal-delete-button" aria-label={`删除长期目标 ${goal.title}`} onClick={() => setGoalToDelete(goal)}><Trash2 size={12} /> 删除</button><button className="text-button" onClick={() => onSplitGoal(goal)}>拆出下一步</button><button className="text-button" onClick={() => void onResumeGoal(goal)}>{goal.diagnosticStatus === "pending" || goal.diagnosticStatus === "in_progress" ? "开始诊断" : "继续学习"} <ChevronRight size={14} /></button></div></div></article>)}
      {dashboard.goals.length === 0 && <button className="goal-empty-card" onClick={openCreateGoal}><Plus size={18} /><strong>创建第一个长期目标</strong><span>写清想达到的结果和大致周期。</span></button>}
    </div></section>}

    {showCreateGoal && <div className="quick-log-overlay" role="dialog" aria-modal="true" aria-label="创建目标">
      <button className="quick-log-backdrop" aria-label="关闭创建目标" disabled={isCreating} onClick={() => setShowCreateGoal(false)} />
      {showCreationProgress ? <section className={`quick-log-dialog goal-progress-dialog is-${visibleCreationProgress.status}`} aria-busy={isCreating} aria-live="polite">
        <div className="goal-progress-animation" aria-hidden="true">
          <div className="goal-progress-orbit"><i /><i /><i /></div>
          <span><Brain size={21} /></span>
        </div>
        <div className="goal-progress-dialog-heading"><span className="eyebrow">BUILDING YOUR PATH</span><h2>{visibleCreationProgress.status === "error" ? "学习路径准备失败" : "正在准备学习路径"}</h2><p>{visibleCreationProgress.message}</p></div>
        <div className="goal-creation-progress-heading"><strong>实际执行进度</strong><em>{visibleCreationProgress.percent}%</em></div>
        <div className="goal-creation-progress-track" role="progressbar" aria-label="学习路径创建进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={visibleCreationProgress.percent}><span style={{ width: `${visibleCreationProgress.percent}%` }} /></div>
        <div className="goal-creation-progress-events">
          {creationEvents.map((event, index) => <div className={index === creationEvents.length - 1 ? "is-current" : "is-finished"} key={`${event.stage}-${index}`}>
            <span className="goal-creation-event-icon">{event.status === "error" ? <X size={11} /> : index < creationEvents.length - 1 || event.status === "done" ? <Check size={11} /> : <i />}</span>
            <span>{event.message}</span><em>{event.percent}%</em>
          </div>)}
        </div>
        <div className="goal-progress-dialog-footer"><span>展示工作流节点与产物进度，不包含模型内部推理原文。</span>{visibleCreationProgress.status === "error" && <button className="quiet-button" onClick={() => { setCreationProgress(null); setCreationEvents([]); }}>返回修改</button>}</div>
      </section> : <section className="quick-log-dialog goal-create-dialog">
        <div className="quick-log-heading">
          <div><span className="eyebrow">NEW GOAL</span><h2>创建目标</h2><p>先拆出可评测能力；已有基础时先做小测，初学者直接进入首课。</p></div>
          <button className="quiz-close-button" onClick={() => setShowCreateGoal(false)}><X size={15} /> 关闭</button>
        </div>
        <div className="goal-create-grid">
          <label className="learning-field"><span>目标名称</span><input value={goalDraft.title} onChange={(event) => setGoalDraft((current) => ({ ...current, title: event.target.value }))} maxLength={100} placeholder="例如：做出可演示的学习助手" /></label>
          <label className="learning-field"><span>目标日期</span><input type="date" value={goalDraft.targetDate} min={minTargetDate()} onChange={(event) => setGoalDraft((current) => ({ ...current, targetDate: event.target.value }))} /><small>留空表示不设期限</small></label>
          <label className="learning-field goal-create-wide"><span>完成标准</span><textarea value={goalDraft.description} onChange={(event) => setGoalDraft((current) => ({ ...current, description: event.target.value }))} maxLength={500} rows={3} placeholder="课程结束时，你希望能独立完成什么？" /></label>
          <fieldset className="learning-field goal-create-wide goal-level-field"><legend>当前掌握程度</legend><div className="goal-level-options">{([{ value: "beginner", label: "初学者", note: "直接从基础首课开始" }, { value: "familiar", label: "一知半解", note: "先做 5 题初始诊断" }, { value: "intermediate", label: "小有所成", note: "先做 8 题进阶诊断" }] as const).map((level) => <button type="button" key={level.value} className={goalDraft.selfLevel === level.value ? "active" : ""} onClick={() => setGoalDraft((current) => ({ ...current, selfLevel: level.value }))}><strong>{level.label}</strong><span>{level.note}</span></button>)}</div></fieldset>
          <label className="learning-field goal-create-wide"><span>当前基础（可选）</span><input value={goalDraft.background} onChange={(event) => setGoalDraft((current) => ({ ...current, background: event.target.value }))} maxLength={500} placeholder="例如：会基础 TypeScript，但没有独立做过 Agent" /></label>
          <label className="learning-field"><span>每周投入</span><input type="number" value={goalDraft.weeklyHours} min={1} max={40} step={1} onChange={(event) => setGoalDraft((current) => ({ ...current, weeklyHours: Number(event.target.value) }))} /><small>1–40 小时</small></label>
        </div>
        <div className="goal-course-note goal-budget-note"><Timer size={14} /><span>{goalDraft.targetDate ? <>还剩 <strong>{plannedWeeks}</strong> 周 · 按每周 {goalDraft.weeklyHours} 小时算，到期前大约有 <strong>{plannedHours}</strong> 小时可投入。</> : <>没有设定目标日期，暂时无法估算可投入的总工时。</>}</span></div>

        {budgetReview && <div className={`goal-budget-review is-${budgetReview.status}`}>
          <div className="goal-budget-review-head">
            {budgetReview.status === "ok" ? <CircleCheck size={14} /> : <CircleAlert size={14} />}
            <p>{budgetReview.reason}</p>
          </div>
          {budgetReview.suggestions.length > 0 && <ul>
            {budgetReview.suggestions.map((suggestion) => <li key={suggestion}>{suggestion}</li>)}
          </ul>}
          <button type="button" className="text-button" onClick={onEditBudget}>调整每周预算 <ChevronRight size={13} /></button>
        </div>}

        {budget && !budget.hasProfile && <div className="goal-course-note">
          <CircleAlert size={14} />
          <span>还没设置每周可投入时间，暂时无法判断多个目标加起来排不排得开。<button type="button" className="text-button" onClick={onEditBudget}>现在设置</button></span>
        </div>}
        <div className="goal-course-note"><Sparkles size={14} /><span>先生成完整路线，但只生成第一节正文；通过导师考核后再生成下一节。</span></div>
        <div className="quick-log-actions"><span>{goalDraft.selfLevel && goalDraft.selfLevel !== "beginner" ? "创建后先进入初始诊断" : "创建后进入首节课程"}</span><button className="primary-button" disabled={!goalDraft.title.trim() || !goalDraft.selfLevel} onClick={() => void submitGoal()}>创建目标并开始<ArrowUpRight size={15} /></button></div>
      </section>}
    </div>}

    {goalToDelete && <div className="quick-log-overlay goal-delete-overlay" role="dialog" aria-modal="true" aria-label="删除长期目标">
      <button className="quick-log-backdrop" aria-label="取消删除" disabled={isDeletingGoal} onClick={() => setGoalToDelete(null)} />
      <section className="quick-log-dialog goal-delete-dialog" aria-busy={isDeletingGoal}>
        <div className="goal-delete-icon"><Trash2 size={18} /></div>
        <div><span className="eyebrow">DELETE GOAL</span><h2>删除「{goalToDelete.title}」？</h2><p>能力地图、初始诊断、课程、课节和关联的今日任务会同步删除；已经留下的学习记录仍会保留。</p></div>
        <div className="goal-delete-warning">此操作无法撤销。</div>
        <div className="goal-delete-actions"><button className="quiet-button" disabled={isDeletingGoal} onClick={() => setGoalToDelete(null)}>取消</button><button className="danger-button" disabled={isDeletingGoal} onClick={() => void confirmDeleteGoal()}>{isDeletingGoal ? "正在删除" : "确认删除"}<Trash2 size={14} /></button></div>
      </section>
    </div>}
  </div>;
}

function evidenceLabel(evidence: "输入" | "输入 + 输出" | "应用") {
  if (evidence === "应用") return "实际应用";
  if (evidence === "输入 + 输出") return "理解回应";
  return "行动记录";
}

function RecordsPanel({ dashboard, logs, onOpenQuickLog, onGenerateQuiz }: { dashboard: DemoSeed; logs: LogEntry[]; onOpenQuickLog: () => void; onGenerateQuiz: (log: LogEntry) => void }) {
  return <div className="workspace-page">
    <section className="panel records-main records-simple"><div className="panel-heading"><div><span className="eyebrow">TODAY</span><h2>今天</h2></div><div className="home-section-actions"><span className="count-badge">{logs.length} 条记录</span><button className="quick-note-button" onClick={onOpenQuickLog}><Plus size={14} /> 随手一记</button></div></div><div className="record-list">
        {logs.map((log) => <article className="record-item record-item-live" key={log.id}><div className="record-date"><strong>{log.createdAt}</strong><span>新增</span></div><div className="record-marker"><span /></div><div className="record-body"><div className="record-topline"><h3>{log.topic}</h3><span className="record-reward">+{log.xp} XP · +{log.coin} coin</span></div><p>{log.text}</p><div className="record-tags">{log.kind && <span className={`record-kind-tag kind-${log.kind}`}>{taskKindLabel(log.kind)}</span>}<span>{log.intent === "plan_today" ? "计划" : log.intent === "review" ? "复盘" : log.output ? "已整理" : "已记录"}</span><span>{log.output ? `AI 摘要：${log.output}` : log.mode === "pending" ? "AI 正在整理" : "等待晚报回顾"}</span>{typeof log.quizScore === "number" && <span>理解 {log.quizScore} 分</span>}</div>{log.output && <button className="record-quiz-button" onClick={() => onGenerateQuiz(log)}>再测一次 <ChevronRight size={13} /></button>}</div></article>)}
        {logs.length === 0 && <div className="records-empty"><strong>今天还没有记录</strong><p>有想法时点“随手一记”，晚上再统一整理。</p></div>}
      </div></section>
    <details className="panel records-history"><summary><span><span className="eyebrow">EARLIER</span><strong>更早的记录</strong></span><span>{dashboard.learningLogs.length} 条 <ChevronRight size={14} /></span></summary><div className="record-list">
      {dashboard.learningLogs.map((log) => <article className="record-item" key={log.id}><div className="record-date"><strong>{log.occurredAt.split(" ")[0]}</strong><span>{log.occurredAt.split(" ").slice(1).join(" ")}</span></div><div className="record-marker"><span /></div><div className="record-body"><div className="record-topline"><h3>{log.topic}</h3><span className="record-reward">+{log.xp} XP · +{log.coin} coin</span></div><p>{log.summary}</p><div className="record-tags"><span>{evidenceLabel(log.evidence)}</span><span>{log.duration}</span></div></div></article>)}
    </div></details>
  </div>;
}

type LearningQuizCardProps = {
  quiz: QuizSession;
  answers: Record<string, string>;
  grade: QuizGrade | null;
  busy: boolean;
  error: string;
  onAnswer: (id: string, value: string) => void;
  onGrade: () => void;
  onReset: () => void;
};

function LearningQuizCard({ quiz, answers, grade, busy, error, onAnswer, onGrade, onReset }: LearningQuizCardProps) {
  const answeredCount = quiz.questions.filter((question) => answers[question.id]?.trim()).length;
  return <section className="quiz-panel"><div className="quiz-panel-header"><div><span className="eyebrow">RECALL CHECK · {quiz.mode === "llm" ? "LLM 出题" : "演示出题"}</span><h2>理解「{quiz.topic}」</h2><p>先别查资料，直接回答，并尽量给一个例子。LLM 会按概念、迁移和表达结构评分。</p></div><div className="quiz-status"><Brain size={18} /><span>{answeredCount}/{quiz.questions.length} 已回答</span></div></div><div className="quiz-source"><span>学习底稿</span><p>{quiz.sourceSummary}</p></div><div className="quiz-question-list">{quiz.questions.map((question, index) => <div className="quiz-question" key={question.id}><div className="quiz-question-top"><span>0{index + 1}</span><strong>{question.prompt}</strong></div><p className="quiz-hint">提示：{question.hint}</p><textarea value={answers[question.id] || ""} onChange={(event) => onAnswer(question.id, event.target.value)} placeholder="写下你的理解，至少给一个具体例子……" rows={3} disabled={Boolean(grade)} /></div>)}</div>{error && <p className="quiz-error" role="alert">{error}</p>}{grade ? <div className="quiz-result"><div className="quiz-result-score"><strong>{grade.score}</strong><span>分</span><em>{grade.level}</em></div><div className="quiz-result-copy"><p>{grade.summary}</p><span>{grade.nextHabit}</span></div></div> : <button className="primary-button quiz-submit" onClick={onGrade} disabled={busy || answeredCount === 0}>{busy ? "LLM 正在评分…" : `提交答案并评分 · ${answeredCount}/${quiz.questions.length}` } <ArrowUpRight size={15} /></button>}{grade && <div className="quiz-feedback-list">{grade.feedback.map((item) => <div className="quiz-feedback" key={item.questionId}><div><strong>第 {quiz.questions.findIndex((question) => question.id === item.questionId) + 1} 题 · {item.score} 分</strong><p>{item.comment}</p></div><span>{item.modelAnswer}</span></div>)}</div>}{grade && <div className="quiz-graded-by"><span>{grade.gradedBy === "llm" ? "LLM 已完成逐题评分" : `LLM 暂时不可用，已使用${grade.provider === "rules" ? "规则" : grade.provider}估分`}</span><button className="quiet-button" onClick={onReset}><RotateCcw size={14} /> 再做一次</button></div>}</section>;
}

function GrowthPanel({ dashboard }: { dashboard: DemoSeed }) {
  const totalMinutes = dashboard.weeklyBars.reduce((total, bar) => total + Number.parseInt(bar.label, 10), 0);
  const applicationCount = dashboard.learningLogs.filter((log) => log.evidence === "应用").length;
  const understandingCount = dashboard.learningLogs.filter((log) => log.evidence === "输入 + 输出").length;
  return <div className="workspace-page">
    <div className="growth-metrics"><article className="metric-card metric-coral"><span className="metric-label">有效行动日</span><strong>{dashboard.user.streak}<small> 天</small></strong><p>连续完成有效学习行动</p></article><article className="metric-card metric-navy"><span className="metric-label">本周投入</span><strong>{Math.floor(totalMinutes / 60)}<small>h</small> {totalMinutes % 60}<small>m</small></strong><p>7 天累计专注时长</p></article><article className="metric-card metric-sage"><span className="metric-label">掌握证据</span><strong>{applicationCount + understandingCount}<small> 条</small></strong><p>回答合格并形成理解</p></article></div>
    <div className="growth-layout"><section className="panel growth-chart-panel"><div className="panel-heading"><div><span className="eyebrow">RHYTHM TREND</span><h2>近 7 天投入节奏</h2></div><span className="trend-chip"><ArrowUpRight size={13} /> 本周数据</span></div><div className="growth-chart">{dashboard.weeklyBars.map((bar, index) => <div className="growth-bar-column" key={bar.day}><span className="growth-bar-value">{bar.label}</span><div className="growth-bar-track"><span className={index === 6 ? "highlight" : ""} style={{ height: `${bar.value}%` }} /></div><span>{bar.day}</span></div>)}</div><div className="chart-caption"><span><i className="legend-dot" /> 有效专注时长</span><strong>累计：{Math.floor(totalMinutes / 60)}h {totalMinutes % 60}m</strong></div></section><section className="panel evidence-panel"><div className="panel-heading"><div><span className="eyebrow">EVIDENCE MIX</span><h2>进步由什么组成</h2></div><BarChart3 size={18} className="panel-icon" /></div><div className="evidence-row"><div className="evidence-label"><span>行动记录</span><strong>{dashboard.learningLogs.length} 条</strong></div><div className="evidence-track"><span style={{ width: `${Math.min(100, dashboard.learningLogs.length * 12)}%` }} /></div></div><div className="evidence-row"><div className="evidence-label"><span>理解回应</span><strong>{understandingCount} 条</strong></div><div className="evidence-track"><span className="evidence-green" style={{ width: `${Math.min(100, understandingCount * 18)}%` }} /></div></div><div className="evidence-row"><div className="evidence-label"><span>实际应用</span><strong>{applicationCount} 条</strong></div><div className="evidence-track"><span className="evidence-gold" style={{ width: `${Math.min(100, applicationCount * 24)}%` }} /></div><p className="evidence-note"><Sparkles size={13} /> {dashboard.insight}</p></div></section></div>
    <section className="panel goal-progress-panel"><div className="panel-heading"><div><span className="eyebrow">GOAL PROGRESS</span><h2>目标的真实进度</h2></div><span className="count-badge">只比较自己的基线</span></div><div className="growth-goal-list">{dashboard.goals.map((goal) => <div className="growth-goal" key={goal.id}><div className="growth-goal-heading"><div><strong>{goal.title}</strong><span>{goal.description}</span></div><em>{goal.progress}%</em></div><div className="goal-progress"><span style={{ width: `${goal.progress}%` }} /></div><div className="growth-goal-footer"><span>{goal.horizon}</span><span>{goal.status}</span></div></div>)}</div></section>
  </div>;
}
