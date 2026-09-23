import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/** Called inside the caller's transaction. Locked lessons stay out of Today. */
export function syncCourseTasks(db: DatabaseSync, userId: string, programId: string) {
  const program = db.prepare('SELECT goal_id,status FROM learning_programs WHERE id=? AND user_id=?').get(programId,userId) as {goal_id:string;status:string}|undefined;
  if(!program) throw new Error('课程不属于当前用户。');
  const now=new Date().toISOString();
  if(program.status!=='active') {
    db.prepare(`UPDATE tasks SET status='skipped',updated_at=? WHERE user_id=? AND status!='done' AND id IN
      (SELECT l.task_id FROM task_lesson_links l JOIN course_lessons c ON c.id=l.lesson_id WHERE c.program_id=?)`).run(now,userId,programId);
    return;
  }
  const lessons=db.prepare("SELECT id,title,objective,duration_minutes,required_score,position,status,updated_at FROM course_lessons WHERE program_id=? AND status IN ('available','passed') ORDER BY position").all(programId) as Array<{id:string;title:string;objective:string;duration_minutes:number;required_score:number;position:number;status:string;updated_at:string}>;
  for(const lesson of lessons) {
    const linked=db.prepare('SELECT t.id FROM tasks t JOIN task_lesson_links l ON l.task_id=t.id WHERE l.lesson_id=? AND t.user_id=?').all(lesson.id,userId) as Array<{id:string}>;
    const status=lesson.status==='passed'?'done':'current';
    if(!linked.length) {
      const id=randomUUID();
      db.prepare(`INSERT INTO tasks(id,user_id,goal_id,title,subtitle,duration_minutes,status,kind,position,completed_at,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,'learn',?,?,?,?)`).run(id,userId,program.goal_id,lesson.title,lesson.objective,lesson.duration_minutes,status,lesson.position,status==='done'?lesson.updated_at:null,now,now);
      db.prepare("INSERT INTO task_lesson_links(task_id,lesson_id,required_score,completion_rule,created_at) VALUES(?,?,?,'passing_score',?)").run(id,lesson.id,lesson.required_score,now);
    } else {
      for(const task of linked) db.prepare(`UPDATE tasks SET goal_id=?,title=?,subtitle=?,duration_minutes=?,status=?,completed_at=CASE WHEN ?='done' THEN COALESCE(completed_at,?) ELSE NULL END,updated_at=? WHERE id=? AND user_id=?`)
        .run(program.goal_id,lesson.title,lesson.objective,lesson.duration_minutes,status,status,now,now,task.id,userId);
    }
  }
}
