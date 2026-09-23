import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// No real credentials, database, or network. Exercise the production normalizers/transport.
process.env.LLM_PROVIDER='fixture';process.env.LLM_API_KEY='test';
process.env.LLM_BASE_URL='https://fixture.invalid';process.env.LLM_MODEL='fixture';
registerHooks({resolve(specifier,context,next){
  if(specifier.startsWith('@/')){
    const base=resolve(specifier.slice(2));
    for(const ext of ['.ts','.tsx','/index.ts'])if(existsSync(base+ext))return next(pathToFileURL(base+ext).href,context);
  }
  return next(specifier,context);
}});
const {gradeLessonCheck,reviewLessonSemantics,lessonGradeErrors,semanticReviewErrors}=await import('../lib/agents/tutor.ts');
const {gradeAdaptiveAnswer}=await import('../lib/agents/examiner.ts');
const {buildLessonQualityReport}=await import('../lib/learning-program/quality.ts');
const questions=['q1','q2','q3'].map(id=>({id,maxScore:100,referenceAnswer:'trusted reference'}));
const input={lesson:{title:'变量赋值'},material:{},questions,answers:Object.fromEntries(questions.map(q=>[q.id,'因为步骤首先然后最后验证检查结果标准'.repeat(30)]))};
const valid={summary:'逐题验证结果',nextStep:'重新解释错误题',feedback:questions.map((q,i)=>({questionId:q.id,score:i*20,maxScore:100,feedback:'本题判断依据',reference:'untrusted generated key'}))};
const original=globalThis.fetch;
let raw=valid,status=200,calls=0;
globalThis.fetch=async()=>{calls++;return status===200?Response.json({choices:[{message:{content:JSON.stringify(raw)}}]}):new Response('',{status});};
try {
  status=503;
  const failed=await gradeLessonCheck(input);
  assert.equal(failed.mode,'rules');assert.equal(failed.data.score,0);assert.deepEqual(failed.data.feedback,[]);
  assert.equal(failed.fallbackReason,'http_503');
  const review=await reviewLessonSemantics({});
  assert.equal(review.data.passed,false);assert.equal(review.data.issues[0].code,'semantic_review_unavailable');
  await assert.rejects(()=>gradeAdaptiveAnswer({question:{id:'d1',maxScore:10},answer:input.answers.q1}),/诊断评分未完成/);
  console.log('PASS: outages cannot produce keyword/length grades, diagnostic evidence or a semantic pass without sources.');

  status=200;
  for(const malformed of [
    {},{feedback:valid.feedback.slice(1)},
    {...valid,feedback:valid.feedback.map((q,i)=>i===0?{...q,questionId:'unknown'}:q)},
    {...valid,feedback:valid.feedback.map((q,i)=>i===1?{...q,questionId:'q1'}:q)},
    {...valid,feedback:valid.feedback.map(q=>({...q,score:'90'}))},
    {...valid,feedback:valid.feedback.map(q=>({...q,score:101}))},
    {...valid,feedback:valid.feedback.map(q=>({...q,maxScore:10}))},
    {...valid,feedback:valid.feedback.map(q=>({...q,feedback:''}))},
  ]) {
    assert(lessonGradeErrors(malformed,questions).length);
    raw=malformed;calls=0;const result=await gradeLessonCheck(input);
    assert.equal(result.mode,'rules');assert.equal(result.data.score,0);assert.equal(calls,2,'one bounded format repair');
  }
  raw={...valid,feedback:[...valid.feedback].reverse()};
  const ordered=await gradeLessonCheck({...input,answers:{...input.answers,q3:''}});
  assert.equal(ordered.mode,'llm');assert.deepEqual(ordered.data.feedback.map(q=>q.score),[0,20,0]);
  assert.equal(ordered.data.score,7);assert(ordered.data.feedback.every(q=>q.reference==='trusted reference'));
  for(const malformed of [{passed:true}, {passed:'true',score:90,issues:[]}, {passed:true,score:90,issues:[{severity:'error',code:'x',message:'x',blockIds:[]}]}]) {
    assert(semanticReviewErrors(malformed).length);raw=malformed;
    const result=await reviewLessonSemantics({});assert.equal(result.mode,'rules');assert.equal(result.data.passed,false);
  }
  raw={score:'10',feedback:'invalid score',evidenceSummary:'invalid'};
  await assert.rejects(()=>gradeAdaptiveAnswer({question:{id:'d1',maxScore:10},answer:'test'}),/validation_failed/);
  raw={passed:true,score:0,issues:[]};
  assert.equal((await reviewLessonSemantics({})).data.score,0,'zero must not become a default score');
  console.log('PASS: exact IDs/count/types, bounded repair, zero/blank handling, trusted answer keys and complete review schema.');

  for(const key of ['LLM_API_KEY','OPENAI_API_KEY','DEEPSEEK_API_KEY','GLM_API_KEY'])delete process.env[key];
  calls=0;assert.equal((await gradeLessonCheck(input)).fallbackReason,'llm_not_configured');assert.equal(calls,0);
  process.env.LLM_PROVIDER='rules';
  const demo=await reviewLessonSemantics({});assert.equal(demo.data.issues[0].code,'demo_semantic_review');
  assert.equal((await gradeLessonCheck(input)).fallbackReason,'llm_disabled');
  // Pure structural validation cannot claim that semantic review ran.
  assert.equal(buildLessonQualityReport({content:{title:'fixture',objective:'fixture',capabilityType:'conceptual_understanding',blocks:[],evidenceRequirements:[],estimatedMinutes:30,modelSummary:''}}).semanticPassed,false);
  console.log('PASS: missing configuration is not explicit demo, and structural checks alone never imply semantic verification.');
} finally {globalThis.fetch=original;}
