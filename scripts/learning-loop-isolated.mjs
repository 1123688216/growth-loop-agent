import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {existsSync,mkdtempSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {tmpdir} from 'node:os';

const live=process.argv.includes('--live');
if(live)process.loadEnvFile('.env.local');
else process.env.LLM_PROVIDER='rules';
// Override after reading config. Never connect the business services to the real database.
process.env.SQLITE_DATABASE_PATH=join(mkdtempSync(join(tmpdir(),'growth-loop-closed-')),'test.sqlite');
process.env.KNOWLEDGE_GATE_MODE='advisory';
process.env.WORKFLOW_AUTO_WEB='false';
process.env.RAG_INGESTION_URL='';
process.env.EMBEDDING_SERVICE_URL='';
registerHooks({resolve(specifier,context,next){
  if(specifier==='next/server')return next('next/server.js',context);
  if(specifier==='@/lib/auth/session')return {url:'data:text/javascript,export async function getCurrentUser(){return {id:"loop-test"};}',shortCircuit:true};
  if(specifier.startsWith('@/')){
    const base=resolve(specifier.slice(2));
    for(const ext of ['.ts','.tsx','/index.ts'])if(existsSync(base+ext))return next(pathToFileURL(base+ext).href,context);
  }
  return next(specifier,context);
}});
const {getDatabase,withTransaction}=await import('../lib/db/index.ts');
const {syncCourseTasks}=await import('../lib/db/course-tasks.ts');
const {createGoalWithProfile,readGoalWithProfile}=await import('../lib/db/goals.ts');
const {ensureGoalSkills,readGoalSkills,readSkillMastery}=await import('../lib/db/learning-loop.ts');
const {generateCourseForGoal,materializeNextLesson}=await import('../lib/learning-loop/service.ts');
const {readAuthoredLesson,readLearningProgram,recordLessonAttempt}=await import('../lib/db/programs.ts');
const {gradeLessonCheck}=await import('../lib/agents/tutor.ts');
const {POST:addTask}=await import('../app/api/tasks/route.ts');
const db=getDatabase(),userId='loop-test',now=new Date().toISOString();
console.log(JSON.stringify({test:'isolated business loop',live,database:process.env.SQLITE_DATABASE_PATH}));
try{
  db.prepare("INSERT INTO users(id,username,password_hash,display_name,created_at,updated_at) VALUES(?,?,'test-only','闭环测试',?,?)").run(userId,userId,now,now);
  const {goal}=createGoalWithProfile({userId,title:'Java 变量赋值与引用基础',description:'理解基本类型与引用赋值的区别，能够预测简短代码输出并解释原因。',horizon:'测试',targetDate:null,selfLevel:'beginner',weeklyHours:3,background:'认识Java基本语法，希望通过小例子练习。'});
  ensureGoalSkills(userId,goal.id,[{key:'assignment',name:'Java变量赋值',description:'区分值复制与引用复制，预测简单赋值代码输出。',targetLevel:3,weight:1,capabilityType:'conceptual_understanding'}]);
  const report=async progress=>console.log(JSON.stringify({stage:progress.stage,message:progress.message}));
  const program=await generateCourseForGoal(userId,goal.id,3,report);
  let lesson=readAuthoredLesson(userId,program.programId,program.lessons[0].id).lesson;
  assert.equal(lesson.generationStatus,'ready',JSON.stringify(lesson.qualityReport));
  assert.equal(lesson.qualityStatus,'passed');
  assert.equal(lesson.sourceStatus,'unverified');
  assert.equal(lesson.questions.length,3);
  assert(program.lessons[0].questions.every(q=>!q.referenceAnswer&&!q.rubric),'No answer keys in public program');
  if(live)assert.equal(lesson.generationMode,'llm','Real course/check required, not template fallback');
  const added=await addTask(new Request('http://localhost/api/tasks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({lessonId:lesson.id})}));
  assert.equal(added.status,200,'course save already created the task; explicit add reuses it');
  const taskId=(await added.json()).task.id;
  assert.equal(db.prepare('SELECT goal_id FROM tasks WHERE id=?').get(taskId).goal_id,goal.id);
  const {PATCH:completeTask}=await import('../app/api/tasks/[id]/route.ts');
  assert.equal((await completeTask(new Request('http://localhost'),{params:Promise.resolve({id:taskId})})).status,409);
  const storedGoal=readGoalWithProfile(userId,goal.id),skill=readGoalSkills(userId,goal.id)[0];
  const gradeInput={goal:storedGoal,skill,lesson:{...lesson,skillId:skill.id},mastery:{score:0,confidence:0},material:lesson.contentVersion.content,questions:lesson.questions};
  const snapshot=()=>({task:db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId).status,goal:db.prepare('SELECT progress_percent FROM goals WHERE id=?').get(goal.id).progress_percent,next:readLearningProgram(userId,program.programId).lessons[1].status});
  console.log('BEFORE',JSON.stringify(snapshot()));
  await assert.rejects(() => materializeNextLesson(userId,program.programId,program.lessons[1].id), /尚未解锁/);
  if(!live){
    const beforeCount=db.prepare('SELECT count(*) n FROM lesson_assessment_attempts').get().n;
    const beforeMastery=readSkillMastery(userId,skill.id),beforeState=snapshot();
    const originalFetch=globalThis.fetch;
    const keys=['LLM_PROVIDER','LLM_API_KEY','LLM_BASE_URL','LLM_MODEL'];
    const config=keys.map(key=>process.env[key]);
    try{
      process.env.LLM_PROVIDER='fixture';process.env.LLM_API_KEY='test';process.env.LLM_BASE_URL='https://fixture.invalid';process.env.LLM_MODEL='fixture';
      globalThis.fetch=async()=>new Response('',{status:503});
      const {POST}=await import('../app/api/learning-program/route.ts');
      const response=await POST(new Request('http://localhost/api/learning-program',{method:'POST',body:JSON.stringify({action:'grade',programId:program.programId,lessonId:lesson.id,answers:Object.fromEntries(lesson.questions.map(q=>[q.id,'因为首先然后最后验证结果'.repeat(30)]))})}));
      assert.equal(response.status,503);assert.equal((await response.json()).code,'grading_unavailable');
      assert.equal(db.prepare('SELECT count(*) n FROM lesson_assessment_attempts').get().n,beforeCount);
      assert.deepEqual(readSkillMastery(userId,skill.id),beforeMastery);assert.deepEqual(snapshot(),beforeState);
      assert.throws(()=>recordLessonAttempt({userId,lesson,answers:{},grade:{gradedBy:'rules',score:100}}),/没有有效模型评分/);
      console.log('PASS: actual grading route/provider failure preserves attempts, mastery, task, goal and next-lesson lock; DB guard rejects bypass.');
    }finally{
      globalThis.fetch=originalFetch;keys.forEach((key,i)=>{if(config[i]===undefined)delete process.env[key];else process.env[key]=config[i]});
    }
  }
  const wrong=Object.fromEntries(lesson.questions.map(q=>[q.id,'不知道']));
  const failedResult=await gradeLessonCheck({...gradeInput,answers:wrong});
  if(live)assert.equal(failedResult.mode,'llm');
  const failed=recordLessonAttempt({userId,lesson,answers:wrong,grade:{...failedResult.data,lessonId:lesson.id}});
  assert.equal(failed.passed,false,'Clearly insufficient answer must not complete a task');
  assert.deepEqual(snapshot(),{task:'current',goal:0,next:'locked'});
  console.log('FAILED_ANSWER',JSON.stringify({score:failed.score,...snapshot()}));
  const firstEvidence=readSkillMastery(userId,skill.id);
  assert.throws(()=>recordLessonAttempt({userId,lesson:{...lesson,contentVersionId:'stale'},answers:wrong,grade:{...failedResult.data,lessonId:lesson.id}}),/课程或题目已改变/);
  assert.equal(db.prepare('SELECT count(*) n FROM lesson_assessment_attempts').get().n,1);
  // Reference-answer fixture tests the plumbing, not human learning or grading accuracy.
  const answers=Object.fromEntries(lesson.questions.map(q=>[q.id,q.referenceAnswer+' 因为应依据上述步骤判断，最后检查结果是否符合题目标准。']));
  const result=await gradeLessonCheck({...gradeInput,answers});
  if(live)assert.equal(result.mode,'llm');
  const grade=recordLessonAttempt({userId,lesson,answers,grade:{...result.data,lessonId:lesson.id}});
  assert.equal(grade.passed,true,'Reference answer should pass');
  assert.equal(snapshot().task,'done');assert(snapshot().goal>0);assert.equal(snapshot().next,'available');
  assert.equal(db.prepare('SELECT count(*) n FROM task_lesson_links l JOIN course_lessons c ON c.id=l.lesson_id WHERE c.program_id=?').get(program.programId).n,2,'only passed and newly unlocked lessons have tasks');
  assert(readSkillMastery(userId,skill.id).confidence>0);
  assert.deepEqual(readSkillMastery(userId,skill.id),firstEvidence,'same question set must not inflate mastery or confidence');
  console.log('PASSED_ANSWER',JSON.stringify({score:grade.score,level:grade.level,...snapshot()}));
  // Follow the web client's separate streamed generation entry, not just its service.
  const {POST:learningAction}=await import('../app/api/learning-program/route.ts');
  const response=await learningAction(new Request('http://localhost/api/learning-program',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'retry-lesson-stream',programId:program.programId,lessonId:grade.nextLessonId})}));
  assert.equal(response.status,200);
  const events=(await response.text()).trim().split('\n').map(line=>JSON.parse(line));
  assert(events.some(event=>event.type==='progress'),'Generation must expose progress');
  assert(!events.some(event=>event.type==='error'),JSON.stringify(events));
  const next=events.find(event=>event.type==='result')?.program;
  assert(next,'Stream must contain persisted program');
  assert.equal(next.lessons[1].generationStatus,'ready','Next lesson must be generated');
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);
  const count=db.prepare('SELECT count(*) n FROM tasks').get().n;
  for(let i=0;i<2;i++)withTransaction(tx=>syncCourseTasks(tx,userId,program.programId));
  assert.equal(db.prepare('SELECT count(*) n FROM tasks').get().n,count,'replay must not duplicate tasks');
  assert.throws(()=>withTransaction(tx=>syncCourseTasks(tx,'foreign-user',program.programId)),/不属于/);
  console.log('PASS',JSON.stringify({live,lessons:next.lessons.length,first:next.lessons[0].status,next:next.lessons[1].generationStatus,task:snapshot().task,goalProgress:snapshot().goal,assessments:db.prepare('SELECT count(*) n FROM lesson_assessment_attempts').get().n}));
  withTransaction(tx=>{tx.prepare("UPDATE learning_programs SET status='archived' WHERE id=?").run(program.programId);syncCourseTasks(tx,userId,program.programId);});
  assert.equal(snapshot().task,'done','archiving preserves completed task history');
  assert.equal(db.prepare("SELECT count(*) n FROM tasks WHERE user_id=? AND status='current'").get(userId).n,0,'old pending course tasks leave Today');
}finally{db.close();}
