"use client";

import { useState } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import {
  ArrowRight,
  BarChart3,
  BedDouble,
  BookOpen,
  CalendarDays,
  Check,
  ChevronRight,
  CircleCheck,
  Clock3,
  Dumbbell,
  Flame,
  Home as HomeIcon,
  LayoutDashboard,
  Moon,
  MoreHorizontal,
  Plus,
  Send,
  Sparkles,
  Target,
  Timer,
  Trophy,
  X,
  Zap,
} from "lucide-react";
import { demoSeed, type Goal, type Task, type TaskKind, weeklyBars } from "@/lib/demo-data";

export type MobileTab = "今日" | "计划" | "记录" | "成长";

type MobileLiveLog = {
  id: string;
  topic: string;
  text: string;
  createdAt: string;
  xp: number;
  coin: number;
  output?: string;
  kind?: TaskKind;
  quizScore?: number;
};

type MobileAppShellProps = {
  activeTab: MobileTab;
  onNavigate: (tab: MobileTab) => void;
  tasks: Task[];
  logs: MobileLiveLog[];
  doneCount: number;
  earnedCoins: number;
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  onSubmit: () => void;
  onToggleTask: (id: string) => void;
  onSplitGoal: (goal: Goal) => void;
  assistantReply: string;
  isAgentBusy: boolean;
  onGenerateQuiz: (log: MobileLiveLog) => void;
  reviewEnabled: boolean;
  onToggleReview: () => void;
  onStartReview: () => void;
  pomodoroVisible: boolean;
  onTogglePomodoro: () => void;
  pomodoro: ReactNode;
  isFocusRunning: boolean;
  onToggleFocus: () => void;
  toast: string;
};

const mobileTabs: Array<{ label: MobileTab; icon: typeof LayoutDashboard; short: string }> = [
  { label: "今日", icon: LayoutDashboard, short: "今天" },
  { label: "计划", icon: CalendarDays, short: "路线" },
  { label: "记录", icon: BookOpen, short: "收集" },
  { label: "成长", icon: Trophy, short: "节奏" },
];

export default function MobileAppShell({
  activeTab,
  onNavigate,
  tasks,
  logs,
  doneCount,
  earnedCoins,
  input,
  setInput,
  onSubmit,
  onToggleTask,
  onSplitGoal,
  assistantReply,
  isAgentBusy,
  reviewEnabled,
  onToggleReview,
  onStartReview,
  pomodoroVisible,
  onTogglePomodoro,
  pomodoro,
  isFocusRunning,
  onToggleFocus,
  toast,
}: MobileAppShellProps) {
  const [composerOpen, setComposerOpen] = useState(false);

  function openComposer(seed = "") {
    onNavigate("今日");
    if (seed) setInput(seed);
    setComposerOpen(true);
  }

  function submitFromComposer() {
    if (!input.trim()) return;
    onSubmit();
    setComposerOpen(false);
  }

  function quickPrompt(prompt: string) {
    setInput(prompt);
    setComposerOpen(true);
  }

  return (
    <main className="app-mobile-v3">
      <div className="app-mobile-v3-safe-top" />
      <header className="app-mobile-v3-topbar">
        <div className="app-mobile-v3-wordmark">
          <span className="app-mobile-v3-spark"><Sparkles size={14} strokeWidth={2.8} /></span>
          <span>成长回路</span>
        </div>
        <div className="app-mobile-v3-top-actions">
          <span className="app-mobile-v3-streak"><Flame size={14} /> {demoSeed.user.streak}</span>
          <button className="app-mobile-v3-avatar" aria-label="打开个人资料">{demoSeed.user.displayName.slice(0, 1)}</button>
        </div>
      </header>

      <div className="app-mobile-v3-scroll">
        {activeTab === "今日" && (
          <MobileTodayV3
            tasks={tasks}
            doneCount={doneCount}
            input={input}
            setInput={setInput}
            onSubmit={onSubmit}
            onToggleTask={onToggleTask}
            onNavigate={onNavigate}
            assistantReply={assistantReply}
            isAgentBusy={isAgentBusy}
            reviewEnabled={reviewEnabled}
            onToggleReview={onToggleReview}
            onStartReview={onStartReview}
            pomodoroVisible={pomodoroVisible}
            onTogglePomodoro={onTogglePomodoro}
            pomodoro={pomodoro}
            isFocusRunning={isFocusRunning}
            onToggleFocus={onToggleFocus}
            onQuickPrompt={quickPrompt}
          />
        )}
        {activeTab === "计划" && (
          <MobilePlanV3
            tasks={tasks}
            doneCount={doneCount}
            onToggleTask={onToggleTask}
            onSplitGoal={onSplitGoal}
            onToggleFocus={onToggleFocus}
            isFocusRunning={isFocusRunning}
          />
        )}
        {activeTab === "记录" && <MobileRecordsV3 logs={logs} onOpenComposer={() => openComposer()} />}
        {activeTab === "成长" && <MobileGrowthV3 earnedCoins={earnedCoins} />}
      </div>

      <button className="app-mobile-v3-fab" onClick={() => openComposer()} aria-label="打开随手记录">
        <Plus size={20} strokeWidth={2.8} />
        <span>记录</span>
      </button>

      <nav className="app-mobile-v3-tabbar" aria-label="移动端主导航">
        {mobileTabs.map(({ label, icon: Icon, short }) => (
          <button key={label} className={activeTab === label ? "is-active" : ""} onClick={() => onNavigate(label)} aria-current={activeTab === label ? "page" : undefined}>
            <Icon size={19} strokeWidth={activeTab === label ? 2.6 : 1.9} />
            <span>{short}</span>
          </button>
        ))}
      </nav>

      {composerOpen && (
        <MobileComposerV3
          input={input}
          setInput={setInput}
          isBusy={isAgentBusy}
          onClose={() => setComposerOpen(false)}
          onSubmit={submitFromComposer}
        />
      )}

      {toast && <div className="app-mobile-v3-toast" role="status" aria-live="polite"><span /><p>{toast}</p></div>}
    </main>
  );
}

function MobileTodayV3({
  tasks,
  doneCount,
  input,
  setInput,
  onSubmit,
  onToggleTask,
  onNavigate,
  assistantReply,
  isAgentBusy,
  reviewEnabled,
  onToggleReview,
  onStartReview,
  pomodoroVisible,
  onTogglePomodoro,
  pomodoro,
  isFocusRunning,
  onToggleFocus,
  onQuickPrompt,
}: {
  tasks: Task[];
  doneCount: number;
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  onSubmit: () => void;
  onToggleTask: (id: string) => void;
  onNavigate: (tab: MobileTab) => void;
  assistantReply: string;
  isAgentBusy: boolean;
  reviewEnabled: boolean;
  onToggleReview: () => void;
  onStartReview: () => void;
  pomodoroVisible: boolean;
  onTogglePomodoro: () => void;
  pomodoro: ReactNode;
  isFocusRunning: boolean;
  onToggleFocus: () => void;
  onQuickPrompt: (prompt: string) => void;
}) {
  const primaryTask = tasks.find((task) => task.status === "current") || tasks.find((task) => task.status !== "done") || tasks[0];
  const visibleTasks = tasks.slice(0, 3);
  const progress = Math.round((doneCount / Math.max(tasks.length, 1)) * 100);

  return (
    <div className="app-mobile-v3-page app-mobile-v3-home">
      <section className="app-mobile-v3-welcome">
        <div>
          <span className="app-mobile-v3-label">{demoSeed.user.weekdayLabel} · {demoSeed.user.dateLabel}</span>
          <h1>今天，做一件<br />对明天有用的事。</h1>
        </div>
        <div className="app-mobile-v3-day-ring" style={{ "--day-progress": `${progress * 3.6}deg` } as React.CSSProperties}>
          <strong>{progress}<small>%</small></strong>
          <span>今日</span>
        </div>
      </section>

      <section className="app-mobile-v3-next-card">
        <div className="app-mobile-v3-next-card-glow" />
        <div className="app-mobile-v3-card-label"><span><Zap size={13} /> NEXT MOVE</span><em>{primaryTask?.duration || "15 min"}</em></div>
        <h2>{primaryTask?.title || "写下今天的第一步"}</h2>
        <p>{primaryTask?.subtitle || "把想法变成一个现在就能开始的动作。"}</p>
        <div className="app-mobile-v3-next-foot">
          <span className={`app-mobile-v3-kind kind-${primaryTask?.kind || "focus"}`}>{taskKindLabel(primaryTask?.kind || "focus")}</span>
          <button onClick={onToggleFocus}>{isFocusRunning ? <><i className="app-mobile-v3-pulse-dot" />专注中</> : <>开始这一小步 <ArrowRight size={15} /></>}</button>
        </div>
      </section>

      <section className="app-mobile-v3-ai-dock">
        <div className="app-mobile-v3-ai-heading">
          <div className="app-mobile-v3-ai-orb"><Sparkles size={16} /></div>
          <div><strong>说给 AI</strong><span>随手记，晚报再整理</span></div>
          <span className="app-mobile-v3-online"><i /> 在线</span>
        </div>
        <p className="app-mobile-v3-ai-reply">{assistantReply}</p>
        <div className="app-mobile-v3-inline-composer">
          <textarea value={input} onChange={(event) => setInput(event.target.value)} placeholder="今天发生了什么？" rows={2} aria-label="今天发生了什么" />
          <button onClick={onSubmit} disabled={!input.trim() || isAgentBusy} aria-label="保存记录">
            {isAgentBusy ? <span className="app-mobile-v3-spinner" /> : <Send size={17} />}
          </button>
        </div>
        <div className="app-mobile-v3-compose-meta"><span>{input.length}/480</span><span>晚上 21:30 统一回顾</span></div>
        <div className="app-mobile-v3-suggestion-row">
          <button onClick={() => onQuickPrompt("今天学了什么：")}>学习</button>
          <button onClick={() => onQuickPrompt("今天完成了一次运动：")}>运动</button>
          <button onClick={() => onQuickPrompt("今天生活里值得记下的一件事：")}>生活</button>
        </div>
      </section>

      <section className="app-mobile-v3-night-strip">
        <div className="app-mobile-v3-moon"><Moon size={16} /></div>
        <div><span>今晚 21:30 · 晚报</span><strong>白天先活，晚上再收束</strong></div>
        <button className={`app-mobile-v3-toggle ${reviewEnabled ? "is-on" : ""}`} aria-pressed={reviewEnabled} onClick={onToggleReview}><i /></button>
        <button className="app-mobile-v3-night-cta" onClick={onStartReview} aria-label="现在开始晚报回顾"><ArrowRight size={16} /></button>
      </section>

      <section className="app-mobile-v3-today-block">
        <div className="app-mobile-v3-block-heading"><div><span className="app-mobile-v3-label">TODAY</span><h2>接下来</h2></div><button onClick={() => onNavigate("计划")}>查看路线 <ChevronRight size={15} /></button></div>
        <div className="app-mobile-v3-task-list">{visibleTasks.map((task) => <MobileTaskV3 key={task.id} task={task} onToggle={onToggleTask} />)}</div>
        <div className="app-mobile-v3-task-progress"><span>{doneCount}/{tasks.length} 已完成</span><i><b style={{ width: `${progress}%` }} /></i></div>
      </section>

      <button className="app-mobile-v3-tool-row" onClick={onTogglePomodoro}>
        <span className="app-mobile-v3-tool-icon"><Timer size={17} /></span>
        <span><strong>{pomodoroVisible ? "专注节奏已打开" : "需要一点节奏？"}</strong><small>{pomodoroVisible ? "25 分钟专注 · 5 分钟恢复" : "番茄钟是可选的，不替你安排生活"}</small></span>
        <ChevronRight size={17} />
      </button>
      {pomodoroVisible && <div className="app-mobile-v3-pomodoro">{pomodoro}</div>}
    </div>
  );
}

function MobileTaskV3({ task, onToggle }: { task: Task; onToggle: (id: string) => void }) {
  return (
    <article className={`app-mobile-v3-task ${task.status === "done" ? "is-done" : task.status === "current" ? "is-current" : ""}`}>
      <div className={`app-mobile-v3-task-marker kind-${task.kind}`}>{renderTaskKindIcon(task.kind, 16)}</div>
      <div className="app-mobile-v3-task-copy"><div><strong>{task.title}</strong><span>{task.time}</span></div><p>{task.duration} · {task.subtitle}</p></div>
      <button className={`app-mobile-v3-check ${task.status === "done" ? "is-checked" : ""}`} onClick={() => onToggle(task.id)} aria-label={`${task.status === "done" ? "撤销" : "完成"}：${task.title}`}>{task.status === "done" ? <Check size={14} strokeWidth={3} /> : <span />}</button>
    </article>
  );
}

function MobilePlanV3({ tasks, doneCount, onToggleTask, onSplitGoal, onToggleFocus, isFocusRunning }: { tasks: Task[]; doneCount: number; onToggleTask: (id: string) => void; onSplitGoal: (goal: Goal) => void; onToggleFocus: () => void; isFocusRunning: boolean }) {
  const goal = demoSeed.goals[0];
  return (
    <div className="app-mobile-v3-page app-mobile-v3-subpage">
      <section className="app-mobile-v3-page-title"><span className="app-mobile-v3-label">ROADMAP</span><h1>把目标放到今天。</h1><p>路线不是待办清单，它只需要告诉你下一步往哪里走。</p></section>
      <section className="app-mobile-v3-goal-card">
        <div className="app-mobile-v3-goal-head"><span>进行中 · {goal.horizon}</span><Target size={17} /></div>
        <h2>{goal.title}</h2><p>{goal.description}</p>
        <div className="app-mobile-v3-goal-track"><b style={{ width: `${goal.progress}%` }} /></div>
        <div className="app-mobile-v3-goal-foot"><span>当前进度</span><strong>{goal.progress}%</strong></div>
      </section>
      <section className="app-mobile-v3-route-card">
        <div className="app-mobile-v3-block-heading"><div><span className="app-mobile-v3-label">AI ROUTE</span><h2>Agent 学习路线</h2></div><Sparkles size={17} /></div>
        <div className="app-mobile-v3-route-step is-current"><div className="app-mobile-v3-route-index">01</div><div><strong>定义问题与验收标准</strong><p>把一个真实问题做成可观察的最小闭环。</p></div><button onClick={() => onSplitGoal({ id: "goal-ai-agent", title: "学习 Agent 并开发自己的 Agent", description: "从一个具体问题做出最小可运行闭环", progress: 0, horizon: "今日路线", status: "进行中" })} aria-label="添加今天的行动"><Plus size={15} /></button></div>
        <div className="app-mobile-v3-route-step"><div className="app-mobile-v3-route-index">02</div><div><strong>连接工具与状态</strong><p>让 Agent 能够完成一次真实动作。</p></div><CircleCheck size={16} /></div>
        <div className="app-mobile-v3-route-step"><div className="app-mobile-v3-route-index">03</div><div><strong>跑通一次对话闭环</strong><p>从输入、判断到结果，留下可验证证据。</p></div><CircleCheck size={16} /></div>
      </section>
      <section className="app-mobile-v3-plan-section"><div className="app-mobile-v3-block-heading"><div><span className="app-mobile-v3-label">TODAY</span><h2>{doneCount}/{tasks.length} 个动作完成</h2></div><button onClick={onToggleFocus}>{isFocusRunning ? "暂停" : "开始专注"}</button></div><div className="app-mobile-v3-task-list">{tasks.map((task) => <MobileTaskV3 key={task.id} task={task} onToggle={onToggleTask} />)}</div></section>
    </div>
  );
}

function MobileRecordsV3({ logs, onOpenComposer }: { logs: MobileLiveLog[]; onOpenComposer: () => void }) {
  const understandingCount = demoSeed.learningLogs.filter((log) => log.evidence !== "输入").length + logs.filter((log) => log.output).length;
  const allRecords = [
    ...logs.map((log) => ({ id: log.id, topic: log.topic, body: log.text, tag: log.output ? "已整理" : "已记录", time: log.createdAt, xp: log.xp, live: true })),
    ...demoSeed.learningLogs.map((log) => ({ id: log.id, topic: log.topic, body: log.summary, tag: log.evidence === "应用" ? "实际应用" : log.evidence === "输入 + 输出" ? "理解回应" : "行动记录", time: log.occurredAt, xp: log.xp, live: false })),
  ];
  return (
    <div className="app-mobile-v3-page app-mobile-v3-subpage">
      <section className="app-mobile-v3-page-title"><span className="app-mobile-v3-label">CAPTURE</span><h1>把今天收进来。</h1><p>想到什么就记什么，晚报会替你把零散片段串成进步。</p></section>
      <button className="app-mobile-v3-capture-cta" onClick={onOpenComposer}><span className="app-mobile-v3-capture-icon"><Plus size={19} /></span><span><strong>刚刚发生了什么？</strong><small>学习、运动、生活、休息，都可以</small></span><ArrowRight size={17} /></button>
      <section className="app-mobile-v3-record-stats"><div><span>本周片段</span><strong>{allRecords.length}</strong></div><div><span>理解记录</span><strong>{understandingCount}</strong></div><div><span>获得 XP</span><strong>{demoSeed.learningLogs.reduce((total, log) => total + log.xp, 0) + logs.reduce((total, log) => total + log.xp, 0)}</strong></div></section>
      <section className="app-mobile-v3-timeline"><div className="app-mobile-v3-block-heading"><div><span className="app-mobile-v3-label">RECENT</span><h2>成长时间线</h2></div><MoreHorizontal size={18} /></div>{allRecords.map((record) => <article className={`app-mobile-v3-timeline-item ${record.live ? "is-live" : ""}`} key={record.id}><div className="app-mobile-v3-timeline-dot" /><div className="app-mobile-v3-timeline-body"><div className="app-mobile-v3-timeline-top"><strong>{record.topic}</strong><span>+{record.xp} XP</span></div><p>{record.body}</p><div className="app-mobile-v3-timeline-meta"><span>{record.tag}</span><time>{record.time}</time></div></div></article>)}</section>
    </div>
  );
}

function MobileGrowthV3({ earnedCoins }: { earnedCoins: number }) {
  const totalMinutes = weeklyBars.reduce((total, bar) => total + Number.parseInt(bar.label, 10), 0);
  const understandingCount = demoSeed.learningLogs.filter((log) => log.evidence !== "输入").length;
  const rhythm = 68;
  return (
    <div className="app-mobile-v3-page app-mobile-v3-subpage">
      <section className="app-mobile-v3-page-title"><span className="app-mobile-v3-label">YOUR RHYTHM</span><h1>看见自己的节奏。</h1><p>成长不是把每一天塞满，而是知道什么让你继续往前。</p></section>
      <section className="app-mobile-v3-rhythm-card"><div className="app-mobile-v3-rhythm-orbit" style={{ "--rhythm-progress": `${rhythm * 3.6}deg` } as React.CSSProperties}><div><strong>{rhythm}</strong><span>本周节奏</span></div></div><div className="app-mobile-v3-rhythm-copy"><span>当前等级 · LV {demoSeed.user.level}</span><h2>{demoSeed.user.role}</h2><p>距离下一级还差 84 XP</p><div className="app-mobile-v3-rhythm-track"><b style={{ width: "68%" }} /></div></div></section>
      <div className="app-mobile-v3-stat-grid"><div><Flame size={16} /><span>连续有效行动</span><strong>{demoSeed.user.streak}<small> 天</small></strong></div><div><Clock3 size={16} /><span>本周投入</span><strong>{Math.floor(totalMinutes / 60)}<small>h</small>{totalMinutes % 60}<small>m</small></strong></div><div><BookOpen size={16} /><span>理解记录</span><strong>{understandingCount}<small> 条</small></strong></div><div><Trophy size={16} /><span>成长积分</span><strong>{demoSeed.user.coinBalance + earnedCoins}<small> coin</small></strong></div></div>
      <section className="app-mobile-v3-week-card"><div className="app-mobile-v3-block-heading"><div><span className="app-mobile-v3-label">LAST 7 DAYS</span><h2>投入的形状</h2></div><BarChart3 size={17} /></div><div className="app-mobile-v3-week-bars">{weeklyBars.map((bar, index) => <div className="app-mobile-v3-week-bar" key={bar.day}><span>{bar.label}</span><i><b className={index === 3 ? "is-highlight" : ""} style={{ height: `${bar.value}%` }} /></i><small>{bar.day}</small></div>)}</div></section>
      <section className="app-mobile-v3-insight"><span className="app-mobile-v3-insight-icon"><Sparkles size={16} /></span><div><span className="app-mobile-v3-label">AI OBSERVATION</span><p>{demoSeed.insight}</p></div></section>
    </div>
  );
}

function MobileComposerV3({ input, setInput, isBusy, onClose, onSubmit }: { input: string; setInput: Dispatch<SetStateAction<string>>; isBusy: boolean; onClose: () => void; onSubmit: () => void }) {
  return (
    <div className="app-mobile-v3-sheet-backdrop" role="presentation" onClick={onClose}>
      <section className="app-mobile-v3-sheet" role="dialog" aria-modal="true" aria-label="随手记录" onClick={(event) => event.stopPropagation()}>
        <div className="app-mobile-v3-sheet-handle" />
        <header><div><span className="app-mobile-v3-label">CAPTURE A MOMENT</span><h2>说给 AI，先不用整理。</h2></div><button onClick={onClose} aria-label="关闭记录"><X size={19} /></button></header>
        <div className="app-mobile-v3-sheet-note"><span className="app-mobile-v3-ai-orb"><Sparkles size={14} /></span><p>写下事实、感受或一个小进展。今晚的晚报会帮你找到它的意义。</p></div>
        <textarea autoFocus value={input} onChange={(event) => setInput(event.target.value)} placeholder="今天发生了什么？" rows={6} aria-label="今天发生了什么" />
        <div className="app-mobile-v3-sheet-foot"><span>{input.length}/480</span><button onClick={onSubmit} disabled={isBusy || !input.trim()}>{isBusy ? <><span className="app-mobile-v3-spinner" />整理中</> : <>保存这一刻 <ArrowRight size={16} /></>}</button></div>
      </section>
    </div>
  );
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
