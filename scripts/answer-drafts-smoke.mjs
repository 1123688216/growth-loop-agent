import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {existsSync,mkdtempSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {tmpdir} from 'node:os';
process.env.LLM_PROVIDER='rules';process.env.WORKFLOW_AUTO_WEB='false';process.env.KNOWLEDGE_GATE_MODE='advisory';
process.env.SQLITE_DATABASE_PATH=join(mkdtempSync(join(tmpdir(),'draft-tests-')),'test.sqlite');
globalThis.draftTestUser='draft-user';
registerHooks({resolve(specifier,context,next){
  if(specifier==='@/lib/auth/session')return {url:'data:text/javascript,export async function getCurrentUser(){return globalThis.draftTestUser ? {id:globalThis.draftTestUser} : null}',shortCircuit:true};
  if(specifier.startsWith('@/')){
    const base=resolve(specifier.slice(2));for(const ext of ['.ts','.tsx','/index.ts'])if(existsSync(base+ext))return next(pathToFileURL(base+ext).href,context);
  }return next(specifier,context);
}});
const {getDatabase}=await import('../lib/db/index.ts');
const {createGoalWithProfile}=await import('../lib/db/goals.ts');
const {ensureGoalSkills}=await import('../lib/db/learning-loop.ts');
const {generateCourseForGoal}=await import('../lib/learning-loop/service.ts');
const {readAuthoredLesson,recordLessonAttempt}=await import('../lib/db/programs.ts');
const {GET,PUT}=await import('../app/api/learning-drafts/route.ts');
const {AnswerDraftController}=await import('../lib/learning-program/answer-draft-controller.ts');
const db=getDatabase(),now=new Date().toISOString();
try{
  for(const id of ['draft-user','other'])db.prepare("INSERT INTO users(id,username,password_hash,display_name,created_at,updated_at) VALUES(?,?,'test','test',?,?)").run(id,id,now,now);
  const {goal}=createGoalWithProfile({userId:'draft-user',title:'变量赋值',description:'解释赋值',horizon:'test',selfLevel:'beginner',weeklyHours:3,background:'',targetDate:null});
  ensureGoalSkills('draft-user',goal.id,[{key:'values',name:'值复制',description:'验证赋值结果',targetLevel:3,weight:1,capabilityType:'conceptual_understanding'}]);
  const program=await generateCourseForGoal('draft-user',goal.id,3),lesson=program.lessons[0],q=lesson.questions[0].id;
  const url=`http://localhost/api/learning-drafts?programId=${program.programId}&lessonId=${lesson.id}`;
  const put=body=>PUT(new Request('http://localhost/api/learning-drafts',{method:'PUT',body:JSON.stringify({programId:program.programId,lessonId:lesson.id,...body})}));
  const initial=await (await GET(new Request(url))).json();assert.equal(initial.revision,0);
  const payload={fingerprint:initial.fingerprint,revision:0,answers:{[q]:'line one\n  line two'}};
  assert.equal((await put(payload)).status,200);
  const restored=await (await GET(new Request(url))).json();assert.deepEqual(restored.answers,payload.answers);assert.equal(restored.revision,1);
  assert.equal((await put(payload)).status,200,'lost-ack retry is idempotent');
  assert.equal((await put({...payload,answers:{[q]:'stale overwrite'}})).status,409);
  assert.equal((await put({...payload,revision:1,answers:{unknown:'x'}})).status,400);
  assert.equal((await put({...payload,revision:1,answers:{[q]:'x'.repeat(3001)}})).status,400);
  assert.equal((await put({...payload,fingerprint:'old'})).status,409);
  globalThis.draftTestUser='other';assert.equal((await GET(new Request(url))).status,404);assert.equal((await put(payload)).status,404);
  globalThis.draftTestUser=null;assert.equal((await GET(new Request(url))).status,401);assert.equal((await put(payload)).status,401);
  globalThis.draftTestUser='draft-user';
  assert.equal((await GET(new Request(url.replace(lesson.id,program.lessons[1].id)))).status,409,'locked lessons cannot save drafts');
  const authored=readAuthoredLesson('draft-user',program.programId,lesson.id).lesson;
  assert.equal(db.prepare('SELECT count(*) n FROM lesson_assessment_attempts').get().n,0,'drafts are not learning evidence');
  recordLessonAttempt({userId:'draft-user',lesson:authored,answers:payload.answers,grade:{lessonId:lesson.id,score:90,summary:'saved result',nextStep:'next',feedback:[],gradedBy:'rules',provider:'test',model:''}});
  const withGrade=await (await GET(new Request(url))).json();
  assert.equal(withGrade.grade.score,90);assert.equal(withGrade.grade.nextLessonId,program.lessons[1].id);assert.equal(withGrade.grade.attemptNumber,1);
  db.prepare("UPDATE course_lessons SET questions_json=? WHERE id=?").run(JSON.stringify(lesson.questions.map(item=>({...item,referenceAnswer:'changed'}))),lesson.id);
  const changed=await (await GET(new Request(url))).json();assert.equal(changed.revision,0);assert.deepEqual(changed.answers,{});assert.equal(changed.grade,null,'old question grades cannot appear on new questions');
  assert.equal((await put({...payload,revision:1})).status,409);
  assert.equal(db.prepare('SELECT count(*) n FROM lesson_assessment_attempts').get().n,1,'draft reads must not create extra attempts');
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);
  console.log('PASS: actual authenticated draft routes, isolated DB persistence, ownership, question fingerprint, stale-tab rejection, lost-ack retry, input limits, no grading side effects.');

  let resolveSave;const puts=[];let fail=false,conflict=false;
  const transport=async(url,options)=>{
    if(!options?.method)return Response.json({fingerprint:'f',questionVersion:'v',revision:0,answers:{q:'restored'},updatedAt:now});
    puts.push(JSON.parse(options.body));
    if(fail)throw new Error('network offline');
    if(conflict)return Response.json({error:'other tab changed'},{status:409});
    if(puts.length===1)await new Promise(resolve=>{resolveSave=resolve});
    return Response.json({revision:puts.length});
  };
  const c=new AnswerDraftController('p','l','v',transport);await c.load();assert.equal(c.getSnapshot().answers.q,'restored');
  c.setAnswer('q','first edit');const saving=c.flush();c.setAnswer('q','newer edit');resolveSave();await saving;
  assert.equal(puts.length,2);assert.equal(puts[1].revision,1);assert.equal(puts[1].answers.q,'newer edit');assert.equal(c.isDirty(),false);
  fail=true;c.setAnswer('q','offline edit');await c.flush();assert.equal(c.getSnapshot().status,'error');assert.equal(c.isDirty(),true);
  fail=false;await c.flush();assert.equal(c.isDirty(),false);
  conflict=true;c.setAnswer('q','keep local');await c.flush();assert.equal(c.getSnapshot().status,'conflict');const calls=puts.length;
  c.setAnswer('q','more local');await c.flush();assert.equal(puts.length,calls);assert.equal(c.getSnapshot().answers.q,'more local');
  const stale=new AnswerDraftController('p','l','wrong',transport);await stale.load();assert.equal(stale.getSnapshot().loaded,false);
  const nativeFetch=globalThis.fetch;
  try {
    globalThis.fetch=async function(){
      assert.equal(this,globalThis,'native browser fetch must retain the Window receiver');
      return Response.json({fingerprint:'browser',questionVersion:'v',revision:0,answers:{},updatedAt:null});
    };
    const browser=new AnswerDraftController('p','l','v');await browser.load();assert.equal(browser.getSnapshot().loaded,true);
    browser.setAnswer('q','browser answer');await browser.flush();assert.equal(browser.isDirty(),false);
  }finally{globalThis.fetch=nativeFetch;}
  console.log('PASS: production draft controller restores, serializes in-flight edits, retries offline failure, preserves conflict text and rejects old UI versions.');
}finally{db.close();}
