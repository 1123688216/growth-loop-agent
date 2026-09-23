import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {existsSync,mkdtempSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {tmpdir} from 'node:os';

process.env.LLM_PROVIDER='rules';process.env.LLM_API_KEY='test';
process.env.LLM_BASE_URL='https://fixture.invalid';process.env.LLM_MODEL='fixture';
process.env.SQLITE_DATABASE_PATH=join(mkdtempSync(join(tmpdir(),'semantic-recovery-')),'test.sqlite');
const state={unavailable:true,material:0,repair:0,check:0,rag:0};globalThis.semanticRecovery=state;
registerHooks({resolve(specifier,context,next){
  if(context.parentURL?.endsWith('/lib/learning-loop/service.ts') && specifier==='@/lib/knowledge/resolve-knowledge')
    return {url:'data:text/javascript,export async function resolveTutorKnowledge(){globalThis.semanticRecovery.rag++;return undefined}',shortCircuit:true};
  if(context.parentURL?.endsWith('/lib/learning-loop/service.ts') && specifier==='@/lib/agents/tutor'){
    const url=pathToFileURL(resolve('lib/agents/tutor.ts')).href;
    return {url:'data:text/javascript,'+encodeURIComponent(`
      import * as original from ${JSON.stringify(url)};
      export async function buildLessonMaterial(...args){globalThis.semanticRecovery.material++;return original.buildLessonMaterial(...args)}
      export async function repairLessonMaterial(...args){globalThis.semanticRecovery.repair++;return original.repairLessonMaterial(...args)}
      export async function buildLessonCheck(...args){globalThis.semanticRecovery.check++;return original.buildLessonCheck(...args)}
      export async function reviewLessonSemantics(...args){
        process.env.LLM_PROVIDER='fixture';
        try{return await original.reviewLessonSemantics(...args)}finally{process.env.LLM_PROVIDER='rules'}
      }`),shortCircuit:true};
  }
  if(specifier.startsWith('@/')){
    const base=resolve(specifier.slice(2));
    for(const ext of ['.ts','.tsx','/index.ts'])if(existsSync(base+ext))return next(pathToFileURL(base+ext).href,context);
  }
  return next(specifier,context);
}});
const original=globalThis.fetch;
globalThis.fetch=async()=>state.unavailable?new Response('',{status:503}):Response.json({choices:[{message:{content:JSON.stringify({passed:true,score:95,issues:[]})}}]});
const {getDatabase}=await import('../lib/db/index.ts');
const {createGoalWithProfile}=await import('../lib/db/goals.ts');
const {ensureGoalSkills}=await import('../lib/db/learning-loop.ts');
const {generateCourseForGoal,materializeNextLesson}=await import('../lib/learning-loop/service.ts');
const {readAuthoredLesson}=await import('../lib/db/programs.ts');
const db=getDatabase(),userId='review-test',now=new Date().toISOString();
try {
  db.prepare("INSERT INTO users(id,username,password_hash,display_name,created_at,updated_at) VALUES(?,?,'test','test',?,?)").run(userId,userId,now,now);
  const {goal}=createGoalWithProfile({userId,title:'Java变量赋值',description:'预测赋值结果',horizon:'test',selfLevel:'beginner',weeklyHours:3,background:'beginner',targetDate:null});
  ensureGoalSkills(userId,goal.id,[{key:'assignment',name:'变量赋值',description:'解释值复制',targetLevel:3,weight:1,capabilityType:'conceptual_understanding'}]);
  const program=await generateCourseForGoal(userId,goal.id,3);
  const id=program.lessons[0].id;
  const read=()=>readAuthoredLesson(userId,program.programId,id).lesson;
  const pending=read();
  assert.equal(pending.generationStatus,'failed');assert.equal(pending.questions.length,0);
  assert.equal(pending.contentVersion.qualityReport.semanticPassed,false);
  assert(pending.contentVersion.qualityReport.issues.some(issue=>issue.code==='semantic_review_unavailable'));
  assert.deepEqual(state,{unavailable:true,material:1,repair:0,check:0,rag:1});
  await materializeNextLesson(userId,program.programId,id);
  assert.equal(read().generationStatus,'failed');assert.deepEqual(read().contentVersion.content.blocks,pending.contentVersion.content.blocks);
  assert.equal(state.material,1);assert.equal(state.repair,0);assert.equal(state.check,0);assert.equal(state.rag,1);
  state.unavailable=false;const events=[];
  await materializeNextLesson(userId,program.programId,id,undefined,async progress=>events.push(progress));
  const recovered=read();
  assert.equal(recovered.generationStatus,'ready');assert.equal(recovered.questions.length,3);
  assert.deepEqual(recovered.contentVersion.content.blocks,pending.contentVersion.content.blocks);
  assert.notEqual(recovered.contentVersionId,pending.contentVersionId);
  assert.equal(state.material,1);assert.equal(state.repair,0);assert.equal(state.check,1);assert.equal(state.rag,1);
  assert(events.some(event=>event.message.includes('仅重试语义复核')));
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);
  console.log('PASS: isolated persistence across review outage/repeated failure/recovery; same body, fresh version, no re-generation/RAG/repair, questions only after review success.');
} finally {db.close();globalThis.fetch=original;}
