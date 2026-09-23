import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
const state={saved:0,failNext:true,nextCalls:0,gradeFailure:false};globalThis.gradeNextSmoke=state;
const modules={
  'next/server':'export const NextResponse=Response;',
  '@/lib/auth/session':'export async function getCurrentUser(){return {id:"u"}}',
  '@/lib/agents/tutor':`export async function gradeLessonCheck(){return {mode:globalThis.gradeNextSmoke.gradeFailure?'rules':'llm',fallbackReason:globalThis.gradeNextSmoke.gradeFailure?'http_503':'',data:{score:90,passed:true}}}`,
  '@/lib/agents/shared':'export function isExplicitDemoMode(){return false}',
  '@/lib/knowledge/resolve-knowledge':'export function resolveTutorKnowledge(){};export class KnowledgeUnresolved extends Error{}',
  '@/lib/db/goals':'export function readGoalWithProfile(){return {id:"g"}}',
  '@/lib/db/learning-loop':'export function readGoalSkills(){return [{id:"s"}]} export function recordAgentRun(){}',
  '@/lib/db/programs':`export function readAuthoredLesson(){return {program:{programId:'p',goalId:'g'},lesson:{id:'l',primarySkillId:'s',generationStatus:'ready',qualityStatus:'passed',generationMode:'llm',questions:[{id:'q'}]}}}
    export function recordLessonAttempt(){globalThis.gradeNextSmoke.saved++;return {score:90,passed:true,nextLessonId:'next'}}
    export function readLearningProgram(){return {programId:'p',lessons:[{id:'l',status:'passed'},{id:'next',status:'available'}]}}`,
  '@/lib/learning-loop/service':`export function generateCourseForGoal(){};export function regenerateCourseForGoal(){};export async function materializeNextLesson(){globalThis.gradeNextSmoke.nextCalls++;if(globalThis.gradeNextSmoke.failNext)throw Error('model unavailable');return {lessons:[{id:'next',generationStatus:'failed'}]}}`,
  '@/lib/learning-program/service':'export function askCourseInstructor(){} export function getLearningProgramStatus(){}',
  '@/lib/workflow/goal-onboarding':'export function runGoalOnboardingWorkflow(){}',
  '@/lib/learning-loop/lesson-evidence':'export class SourceSelectionRequired extends Error{}',
};
registerHooks({resolve(specifier,context,next){
  if(context.parentURL?.endsWith('/app/api/learning-program/route.ts') && modules[specifier])return {url:'data:text/javascript,'+encodeURIComponent(modules[specifier]),shortCircuit:true};
  return next(specifier,context);
}});
const {POST}=await import('../app/api/learning-program/route.ts');
for(const failNext of [true,false]){
  state.failNext=failNext;state.saved=0;
  const result=await POST(new Request('http://localhost/api/learning-program',{method:'POST',body:JSON.stringify({action:'grade',programId:'p',lessonId:'l',answers:{q:'test'}})}));
  assert.equal(result.status,200);
  const data=await result.json();assert.equal(state.saved,1);assert.equal(data.grade.passed,true);assert(data.nextLessonWarning.includes('已保存'));
}
console.log('PASS: next lesson transport failure or quality failure preserves committed grade and returns a visible warning.');
state.saved=0;state.nextCalls=0;
const deferred=await POST(new Request('http://localhost/api/learning-program',{method:'POST',body:JSON.stringify({action:'grade',programId:'p',lessonId:'l',answers:{q:'test'},deferNextLesson:true})}));
assert.equal(deferred.status,200);
const payload=await deferred.json();
assert.equal(state.saved,1);assert.equal(state.nextCalls,0);
assert.equal(payload.grade.nextLessonId,'next');assert.equal(payload.program.lessons[1].status,'available');
console.log('PASS: deferred web grading commits and returns the grade/unlocked lesson without waiting for next generation.');
state.gradeFailure=true;state.saved=0;state.nextCalls=0;
const rejected=await POST(new Request('http://localhost/api/learning-program',{method:'POST',body:JSON.stringify({action:'grade',programId:'p',lessonId:'l',answers:{q:'long answer'}})}));
assert.equal(rejected.status,503);const pending=await rejected.json();
assert.equal(pending.code,'grading_unavailable');assert.equal(pending.retryable,true);
assert.equal(state.saved,0);assert.equal(state.nextCalls,0);assert.equal(pending.grade,undefined);
console.log('PASS: failed model grading cannot commit a fallback score or unlock/generate the next lesson.');
