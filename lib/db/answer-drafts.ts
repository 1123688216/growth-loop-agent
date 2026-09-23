import { createHash } from 'node:crypto';
import { getDatabase, withTransaction } from './index.ts';
import { readAuthoredLesson } from './programs.ts';
import type { CourseLessonGrade } from '../learning-program/types.ts';

export class DraftError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}
type DraftRow = { answers_json: string; revision: number; updated_at: string };
type AttemptRow = {score:number;passed:number;level:string;attempt_number:number;grader_mode:'llm'|'rules';provider:string;model:string;feedback_json:string;answers_json:string};

function scope(userId: string, programId: string, lessonId: string) {
  const found = readAuthoredLesson(userId, programId, lessonId);
  if (!found) throw new DraftError('找不到属于你的课程。', 404);
  const lesson = found.lesson;
  if (lesson.generationStatus !== 'ready' || ['locked','archived'].includes(lesson.status) || !lesson.questions.length)
    throw new DraftError('当前课节尚不可作答。', 409);
  const fingerprint = createHash('sha256').update(JSON.stringify([lesson.contentVersionId || null, lesson.questions])).digest('hex');
  return { lesson, fingerprint };
}
function view(fingerprint: string, row?: DraftRow) {
  return { fingerprint, revision: row?.revision || 0, answers: row ? JSON.parse(row.answers_json) as Record<string,string> : {}, updatedAt: row?.updated_at || null };
}
export function readAnswerDraft(userId: string, programId: string, lessonId: string) {
  const { lesson, fingerprint } = scope(userId, programId, lessonId);
  const row = getDatabase().prepare('SELECT answers_json, revision, updated_at FROM lesson_answer_drafts WHERE user_id=? AND lesson_id=? AND question_fingerprint=?')
    .get(userId,lessonId,fingerprint) as DraftRow | undefined;
  const attempt=getDatabase().prepare(`SELECT score,passed,level,attempt_number,grader_mode,provider,model,feedback_json,answers_json
    FROM lesson_assessment_attempts WHERE user_id=? AND lesson_id=? AND content_version_id IS ? AND questions_json=?
    AND grader_mode IN ('llm','rules') AND score IS NOT NULL ORDER BY attempt_number DESC LIMIT 1`)
    .get(userId,lessonId,lesson.contentVersionId || null,JSON.stringify(lesson.questions)) as AttemptRow | undefined;
  let grade: CourseLessonGrade | null=null;
  let submittedAnswers: Record<string,string>={};
  if(attempt){
    try{
      const feedback=JSON.parse(attempt.feedback_json);
      const levels: Record<string,CourseLessonGrade['level']>={unqualified:'不合格',qualified:'合格',good:'良',excellent:'优'};
      const next=attempt.passed?getDatabase().prepare(`SELECT id FROM course_lessons WHERE program_id=? AND position>(SELECT position FROM course_lessons WHERE id=?)
        AND status NOT IN ('locked','archived') ORDER BY position LIMIT 1`).get(programId,lessonId) as {id:string}|undefined:undefined;
      if(Array.isArray(feedback.feedback)) grade={lessonId,score:attempt.score,passed:attempt.passed===1,level:levels[attempt.level],attemptNumber:attempt.attempt_number,
        gradedBy:attempt.grader_mode,provider:attempt.provider,model:attempt.model,summary:feedback.summary,nextStep:feedback.nextStep,feedback:feedback.feedback,nextLessonId:next?.id};
      submittedAnswers=JSON.parse(attempt.answers_json);
    }catch{grade=null;submittedAnswers={};}
  }
  return {...view(fingerprint,row),answers:row?view(fingerprint,row).answers:submittedAnswers,grade,
    questionVersion:`${lesson.contentVersionId || 'legacy'}:${lesson.questions.map(q=>q.id).join(',')}`};
}
export function saveAnswerDraft(userId: string, input: { programId: string; lessonId: string; fingerprint: string; revision: number; answers: unknown }) {
  return withTransaction(db => {
    const { lesson, fingerprint } = scope(userId,input.programId,input.lessonId);
    if (fingerprint !== input.fingerprint) throw new DraftError('课程题目已改变，草稿未覆盖新题。请复制当前答案，再刷新课程。',409);
    if (!Number.isSafeInteger(input.revision) || input.revision < 0) throw new DraftError('草稿版本不正确。');
    if (!input.answers || typeof input.answers !== 'object' || Array.isArray(input.answers)) throw new DraftError('答案格式不正确。');
    const entries = Object.entries(input.answers);
    const ids = new Set(lesson.questions.map(q => q.id));
    if (entries.some(([id,value]) => !ids.has(id) || typeof value !== 'string' || value.length > 3000)) throw new DraftError('答案包含未知题目或超过每题3000字限制。');
    const json = JSON.stringify(Object.fromEntries(entries.sort(([a],[b]) => a.localeCompare(b))));
    const row = db.prepare('SELECT answers_json,revision,updated_at FROM lesson_answer_drafts WHERE user_id=? AND lesson_id=? AND question_fingerprint=?')
      .get(userId,input.lessonId,fingerprint) as DraftRow | undefined;
    // A lost acknowledgement can be retried without creating a second write.
    if (row?.answers_json === json) return view(fingerprint,row);
    if ((row?.revision || 0) !== input.revision) throw new DraftError('另一页面已更新草稿，本页未覆盖它。请复制当前答案，再刷新核对。',409);
    const updatedAt = new Date().toISOString(), revision = input.revision + 1;
    db.prepare(`INSERT INTO lesson_answer_drafts(user_id,lesson_id,question_fingerprint,answers_json,revision,updated_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,lesson_id,question_fingerprint) DO UPDATE SET
      answers_json=excluded.answers_json,revision=excluded.revision,updated_at=excluded.updated_at`)
      .run(userId,input.lessonId,fingerprint,json,revision,updatedAt);
    return view(fingerprint,{answers_json:json,revision,updated_at:updatedAt});
  });
}
