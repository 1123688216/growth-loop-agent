import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

// All business persistence uses a fresh DB. No real LLM, network or user course is touched.
process.env.LLM_PROVIDER = 'rules';
process.env.KNOWLEDGE_GATE_MODE = 'advisory';
process.env.WORKFLOW_AUTO_WEB = 'false';
process.env.SQLITE_DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'course-regeneration-')), 'test.sqlite');
const state = { plannerFailure: false, tutorFailure: false, plannerCalls: 0 };
globalThis.regenerationSmoke = state;
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'next/server') return next('next/server.js', context);
  if (specifier === '@/lib/auth/session') return { url: 'data:text/javascript,export async function getCurrentUser(){return {id:"regen-test"}}', shortCircuit: true };
  if (context.parentURL?.endsWith('/lib/learning-loop/service.ts') && specifier === '@/lib/agents/planner') {
    const url = pathToFileURL(resolve('lib/agents/planner.ts')).href;
    return { url: 'data:text/javascript,' + encodeURIComponent(`
      import * as original from ${JSON.stringify(url)};
      export const buildSkillMap = original.buildSkillMap;
      export async function buildCourseOutline(goal, skills, count) {
        const s = globalThis.regenerationSmoke; s.plannerCalls++; s.input = {goal, skills, count};
        const result = await original.buildCourseOutline(goal, skills, count);
        if (s.plannerFailure) return {...result, fallbackReason:'timeout_90000ms'};
        if (s.plannerCalls === 1) return result;
        return {...result, mode:'llm', fallbackReason:'', data:{...result.data,
          title:'Java 变量与控制流', lessons:result.data.lessons.map((lesson, i)=>({...lesson,
            title:['变量赋值与值复制','条件分支与布尔表达式','循环与累加验证'][i]}))}};
      }`), shortCircuit: true };
  }
  if (context.parentURL?.endsWith('/lib/learning-loop/service.ts') && specifier === '@/lib/agents/tutor') {
    const url = pathToFileURL(resolve('lib/agents/tutor.ts')).href;
    return { url: 'data:text/javascript,' + encodeURIComponent(`
      import * as original from ${JSON.stringify(url)};
      export const buildLessonCheck=original.buildLessonCheck, repairLessonMaterial=original.repairLessonMaterial,
        reviewLessonSemantics=original.reviewLessonSemantics;
      export async function buildLessonMaterial(...args) {
        const result=await original.buildLessonMaterial(...args);
        return globalThis.regenerationSmoke.tutorFailure ? {...result, fallbackReason:'simulated_tutor_failure'} : result;
      }`), shortCircuit: true };
  }
  if (specifier.startsWith('@/')) {
    const base = resolve(specifier.slice(2));
    for (const ext of ['.ts', '.tsx', '/index.ts']) if (existsSync(base + ext)) return next(pathToFileURL(base + ext).href, context);
  }
  return next(specifier, context);
} });
const { getDatabase } = await import('../lib/db/index.ts');
const { createGoalWithProfile, readGoalWithProfile } = await import('../lib/db/goals.ts');
const { ensureGoalSkills, readGoalSkills } = await import('../lib/db/learning-loop.ts');
const { generateCourseForGoal, regenerateCourseForGoal } = await import('../lib/learning-loop/service.ts');
const { readAuthoredLesson, readLearningProgramForGoal, recordLessonAttempt, saveLearningProgram } = await import('../lib/db/programs.ts');
const { POST: addTask } = await import('../app/api/tasks/route.ts');
const { POST } = await import('../app/api/learning-program/route.ts');
const db = getDatabase(), userId = 'regen-test', now = new Date().toISOString();
try {
  db.prepare("INSERT INTO users(id,username,password_hash,display_name,created_at,updated_at) VALUES(?,?,'test-only','test',?,?)").run(userId, userId, now, now);
  const { goal } = createGoalWithProfile({ userId, title:'我想学习Java技术', description:'能够编写并解释简单的计算程序',
    horizon:'测试', targetDate:null, selfLevel:'beginner', weeklyHours:4, background:'熟悉计算机基础，尚未学习Java' });
  const skills = ensureGoalSkills(userId, goal.id, [{key:'variables',name:'变量赋值',description:'通过短例子解释变量复制的结果',targetLevel:3,weight:1,capabilityType:'conceptual_understanding'}]);
  const original = await generateCourseForGoal(userId, goal.id, 3);
  // Simulate an already completed diagnostic profile; regeneration must reuse it rather than restart diagnosis.
  db.prepare("UPDATE goal_learning_profiles SET self_level='familiar',diagnostic_required=1,diagnostic_status='completed' WHERE goal_id=?").run(goal.id);
  const lesson = readAuthoredLesson(userId, original.programId, original.lessons[0].id).lesson;
  assert.equal(lesson.generationStatus, 'ready');
  const added = await addTask(new Request('http://localhost/api/tasks', {method:'POST',body:JSON.stringify({lessonId:lesson.id})}));
  assert.equal(added.status, 200, 'automatic course task is reused');
  const taskId=(await added.json()).task.id;
  const grade={lessonId:lesson.id,score:90,level:'优',passed:true,summary:'fixture',nextStep:'next',feedback:[],gradedBy:'rules',provider:'test',model:''};
  recordLessonAttempt({userId,lesson,answers:{},grade});
  const beforeMastery=db.prepare('SELECT * FROM skill_mastery WHERE user_id=?').all(userId);
  const beforeProfile=readGoalWithProfile(userId,goal.id);
  const snapshot=()=>({active:readLearningProgramForGoal(userId,goal.id).programId,
    count:db.prepare('SELECT count(*) n FROM learning_programs').get().n,
    progress:db.prepare('SELECT progress_percent n FROM goals WHERE id=?').get(goal.id).n});
  const before=snapshot();
  assert.equal(before.progress,33);
  const calls=state.plannerCalls;
  assert.equal((await generateCourseForGoal(userId,goal.id)).programId,original.programId);
  assert.equal(state.plannerCalls,calls,'normal prepare reuses existing course');
  await assert.rejects(()=>regenerateCourseForGoal('other-user',original.programId), /找不到/);
  const missing=await POST(new Request('http://localhost/api/learning-program',{method:'POST',body:JSON.stringify({action:'regenerate-course-stream',programId:'not-owned'})}));
  assert.equal(missing.status,404);
  db.prepare("UPDATE goal_learning_profiles SET diagnostic_status='pending' WHERE goal_id=?").run(goal.id);
  await assert.rejects(()=>regenerateCourseForGoal(userId,original.programId), /初始诊断/);
  db.prepare("UPDATE goal_learning_profiles SET diagnostic_status='completed' WHERE goal_id=?").run(goal.id);
  const readyRetry=await POST(new Request('http://localhost/api/learning-program',{method:'POST',body:JSON.stringify({action:'retry-lesson-stream',programId:original.programId,lessonId:lesson.id})}));
  assert.equal(JSON.parse((await readyRetry.text()).trim()).program.programId,original.programId);
  assert.equal(state.plannerCalls,calls,'retrying ready lesson must not replan whole course');
  state.plannerFailure=true;
  await assert.rejects(()=>regenerateCourseForGoal(userId,original.programId), /timeout_90000ms/);
  assert.deepEqual(snapshot(),before,'planner failure preserves current course and progress');
  state.plannerFailure=false; state.tutorFailure=true;
  await assert.rejects(()=>regenerateCourseForGoal(userId,original.programId), /simulated_tutor_failure/);
  assert.deepEqual(snapshot(),before,'first-lesson failure preserves current course');
  state.tutorFailure=false;
  const response=await POST(new Request('http://localhost/api/learning-program',{method:'POST',body:JSON.stringify({action:'regenerate-course-stream',programId:original.programId})}));
  assert.equal(response.status,200);
  const events=(await response.text()).trim().split('\n').map(line=>JSON.parse(line));
  assert(!events.some(event=>event.type==='error'),JSON.stringify(events));
  const next=events.find(event=>event.type==='result').program;
  assert.notEqual(next.programId,original.programId);
  assert.equal(next.version,2);
  assert.equal(next.lessons[0].title,'变量赋值与值复制');
  assert.notEqual(next.lessons[0].title,original.lessons[0].title);
  assert.notEqual(next.lessons[0].id,lesson.id,'new first lesson must not reuse first:goal id');
  assert.equal(next.lessons[0].generationStatus,'ready');
  assert(next.lessons[0].questions.every(question=>!question.referenceAnswer&&!question.rubric));
  assert.equal(snapshot().progress,0);
  assert.equal(db.prepare('SELECT status FROM learning_programs WHERE id=?').get(original.programId).status,'archived');
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId).status,'done');
  assert.equal(db.prepare('SELECT count(*) n FROM lesson_assessment_attempts WHERE lesson_id=?').get(lesson.id).n,1);
  assert.deepEqual(db.prepare('SELECT * FROM skill_mastery WHERE user_id=?').all(userId),beforeMastery);
  assert.deepEqual(readGoalSkills(userId,goal.id).map(skill=>skill.id),skills.map(skill=>skill.id));
  for(const field of ['title','description','selfLevel','background','weeklyHours','targetDate','diagnosticStatus'])
    assert.deepEqual(readGoalWithProfile(userId,goal.id)[field],beforeProfile[field],field);
  assert.equal(state.input.goal.background,beforeProfile.background);
  assert.equal(state.input.goal.weeklyHours,4);
  assert.equal(state.input.count,3);
  for(const stage of ['load_goal','course_outline','lesson_material','lesson_quality','lesson_check','persist'])
    assert(events.some(event=>event.progress?.stage===stage),stage);
  const updated=snapshot();
  await assert.rejects(()=>regenerateCourseForGoal(userId,original.programId), /版本已改变/);
  assert.deepEqual(snapshot(),updated);
  // Failed persistence rolls back the archive operation as well.
  assert.throws(()=>saveLearningProgram({userId,goalId:goal.id,replaceProgramId:next.programId,
    program:{...next,model:'fixture'}})); // Duplicate program ID forces an INSERT failure.
  assert.deepEqual(snapshot(),updated);
  assert.equal(db.prepare('SELECT status FROM learning_programs WHERE id=?').get(next.programId).status,'active');
  recordLessonAttempt({userId,lesson,answers:{},grade});
  assert.equal(snapshot().progress,0,'historical course grade must not overwrite active route progress');
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);
  console.log('PASS: shared generation, original profile, progress stream, authorization, failure/transaction rollback, version switch and historical records preserved (isolated DB; simulated planner).');
} finally { db.close(); }
