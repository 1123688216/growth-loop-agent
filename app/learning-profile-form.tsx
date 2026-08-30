"use client";

import { useState } from "react";
import { AlertTriangle, CalendarClock, Check, LoaderCircle } from "lucide-react";

import {
  DEFAULT_SUSTAINABLE_WEEKLY_MINUTES,
  formatHours,
  spreadWeeklyMinutes,
  weeklyMinutes,
  WEEKDAY_LABELS,
  type PreferredPeriod,
  type PreferredSession,
  type UserLearningProfile,
  type WeekdayMinutes,
} from "@/lib/learning-budget";

const PERIODS: Array<{ value: PreferredPeriod; label: string }> = [
  { value: "morning", label: "清晨" },
  { value: "daytime", label: "白天" },
  { value: "evening", label: "晚上" },
  { value: "late_night", label: "深夜" },
  { value: "flexible", label: "不固定" },
];

const SESSIONS: Array<{ value: PreferredSession; label: string; hint: string }> = [
  { value: "fragment", label: "碎片", hint: "15–30 分钟" },
  { value: "standard", label: "常规", hint: "45–60 分钟" },
  { value: "long", label: "长块", hint: "60 分钟以上" },
];

/**
 * 一周作息与学习习惯。逐日存储是因为打卡按天结算——
 * 「每周 5 小时」推不出「今天该学多久」，而周末和工作日通常差很多。
 */
export default function LearningProfileForm({ initial, saving, onSave, onSkip, title, description }: {
  initial: UserLearningProfile;
  saving: boolean;
  onSave: (profile: UserLearningProfile) => void;
  onSkip?: () => void;
  title: string;
  description: string;
}) {
  const [weekday, setWeekday] = useState<WeekdayMinutes>(initial.weekdayMinutes);
  const [period, setPeriod] = useState<PreferredPeriod>(initial.preferredPeriod);
  const [session, setSession] = useState<PreferredSession>(initial.preferredSession);
  const [habitNote, setHabitNote] = useState(initial.habitNote);
  const [fillHours, setFillHours] = useState(Math.round(weeklyMinutes(initial.weekdayMinutes) / 60) || 8);

  const total = weeklyMinutes(weekday);
  const activeDays = weekday.filter((minutes) => minutes > 0).length;
  // 经验阈值：业余学习每周超过这个量很难连续保持几个月。只提示，不阻止。
  const heavy = total > DEFAULT_SUSTAINABLE_WEEKLY_MINUTES;

  function setDay(index: number, minutes: number) {
    const next = weekday.map((value, position) => position === index ? Math.max(0, Math.min(960, minutes)) : value) as WeekdayMinutes;
    setWeekday(next);
    // 逐日改动后同步上面的每周时长，避免两个数字对不上。
    setFillHours(Math.max(1, Math.round(weeklyMinutes(next) / 60)));
  }

  function applyFill(days: boolean[]) {
    setWeekday(spreadWeeklyMinutes(fillHours * 60, days));
  }

  return <section className="quick-log-dialog learning-profile-dialog">
    <div className="quick-log-heading">
      <div><span className="eyebrow">LEARNING CAPACITY</span><h2>{title}</h2><p>{description}</p></div>
    </div>

    <div className="learning-profile-fill">
      <span className="learning-profile-fill-label">每周学习时长</span>
      <div className="learning-profile-unit">
        <input type="number" min={1} max={80} value={fillHours} aria-label="每周学习时长（小时）" onChange={(event) => setFillHours(Math.max(1, Math.min(80, Number(event.target.value) || 1)))} />
        <em>小时 / 周</em>
      </div>
      <span className="learning-profile-fill-label">分配到</span>
      <div className="learning-profile-fill-actions">
        <button type="button" onClick={() => applyFill([true, true, true, true, true, false, false])}>工作日</button>
        <button type="button" onClick={() => applyFill([false, false, false, false, false, true, true])}>周末</button>
        <button type="button" onClick={() => applyFill([true, true, true, true, true, true, true])}>每天</button>
      </div>
    </div>

    <div className="learning-profile-week" role="group" aria-label="每天可投入分钟数">
      {WEEKDAY_LABELS.map((label, index) => <label key={label} className={weekday[index] > 0 ? "is-active" : ""}>
        <span>{label}</span>
        <input type="number" min={0} max={960} step={15} value={weekday[index]} aria-label={`${label}可投入分钟数`} onChange={(event) => setDay(index, Number(event.target.value) || 0)} />
        <small>分钟</small>
      </label>)}
    </div>

    <p className={`learning-profile-total ${heavy ? "is-heavy" : ""}`}>
      {heavy ? <AlertTriangle size={14} /> : <CalendarClock size={14} />}
      每周合计 <strong>{formatHours(total)}</strong>，{activeDays} 个学习日
      {heavy && <em>——这个强度很难长期保持，确认真能坚持再这么排。</em>}
    </p>

    <div className="goal-create-grid">
      <label className="learning-field"><span>习惯时段</span>
        <select value={period} onChange={(event) => setPeriod(event.target.value as PreferredPeriod)}>
          {PERIODS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>
      </label>
      <label className="learning-field"><span>单次学多久</span>
        <select value={session} onChange={(event) => setSession(event.target.value as PreferredSession)}>
          {SESSIONS.map((item) => <option key={item.value} value={item.value}>{item.label} · {item.hint}</option>)}
        </select>
      </label>
      <label className="learning-field goal-create-wide"><span>其他习惯（可选）</span>
        <input value={habitNote} onChange={(event) => setHabitNote(event.target.value)} maxLength={500} placeholder="例如：通勤路上只能听、周三固定加班" />
      </label>
    </div>

    <div className="quick-log-actions">
      <span>规划师会按这个作息安排每日任务</span>
      <div className="learning-profile-actions">
        {onSkip && <button type="button" className="quiet-button" onClick={onSkip}>以后再说</button>}
        <button type="button" className="primary-button" disabled={saving || total === 0} onClick={() => onSave({
          weekdayMinutes: weekday,
          // 上限不再单独让用户填：它和每周预算表达的是同一件事，
          // 强度过高在上面已经实时提示。这里沿用已有值，保持数据不变。
          sustainableWeeklyMinutes: initial.sustainableWeeklyMinutes,
          preferredPeriod: period,
          preferredSession: session,
          habitNote,
        })}>
          {saving ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}
          {saving ? "正在保存" : "保存学习作息"}
        </button>
      </div>
    </div>
  </section>;
}

export { DEFAULT_SUSTAINABLE_WEEKLY_MINUTES };
