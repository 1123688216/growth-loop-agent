"use client";

import type { CourseLesson } from "@/lib/learning-program/types";

export default function LessonQualityDetails({ lesson }: { lesson: CourseLesson }) {
  const report = lesson.qualityReport;
  const failed = lesson.generationStatus === "failed" || lesson.qualityStatus === "failed";
  if (!report) return failed ? <p className="learning-error">当前版本没有可读取的详细质量报告，无法确定具体失败项。请重新生成后查看，不会把缺失报告显示为检查通过。</p> : null;
  const errors = report.issues.filter((issue) => issue.severity === "error").length;
  const warnings = report.issues.length - errors;
  const pendingReview = report.issues.some(issue => issue.code === "semantic_review_unavailable");
  const demoReview = report.issues.some(issue => issue.code === "demo_semantic_review");
  return <details className="learning-quality-details" open={failed}>
    <summary>课程内容检查：{pendingReview ? "审核服务未完成，等待复核" : `${errors} 项需修复 · ${warnings} 项建议`}</summary>
    <p>这是当前版本的 AI 教学内容检查，不是你的学习成绩。{pendingReview ? "正文已保存，重试会保留正文并重新复核，不会仅因服务故障反复重写。" : "重新生成后显示最新报告。"}</p>
    <p>结构检查：{report.deterministicPassed ? "通过" : "未通过"}；语义检查：{demoReview ? "演示模式，未执行模型复核" : pendingReview ? "待复核（不是内容不合格）" : report.semanticPassed ? "通过" : "未通过或尚未执行"}。</p>
    {report.checkedAt && <small>检查时间：{report.checkedAt.replace("T", " ")}</small>}
    {report.issues.length ? <ol>{report.issues.map((issue, index) => <li key={`${issue.code}-${index}`}>
      <strong>{issue.severity === "error" ? "需修复" : "建议改善"}：{issue.message}</strong>
      <p>涉及内容：{issue.blockIds.length ? issue.blockIds.map((id) => lesson.blocks?.find((block) => block.id === id)?.title || `教学块 ${id}`).join("、") : "整节课程或整体结构"}</p>
      <p>修复建议：{issue.repairInstruction || "检查器未提供具体修复建议。"}</p>
      <small>问题编号：{issue.code}</small>
    </li>)}</ol> : <p>{failed ? "报告没有记录具体问题，但当前课程未就绪，不能视为检查通过。" : "当前报告没有记录问题。"}</p>}
  </details>;
}
