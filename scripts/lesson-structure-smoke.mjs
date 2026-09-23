import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
registerHooks({resolve(specifier,context,next){
  if(specifier.startsWith('@/')){
    const base=resolve(specifier.slice(2));
    for(const ext of ['.ts','.tsx','/index.ts'])if(existsSync(base+ext))return next(pathToFileURL(base+ext).href,context);
  }
  return next(specifier,context);
}});
const live=process.argv.includes('--live');
if(live) process.loadEnvFile('.env.local');
else {process.env.LLM_PROVIDER='test';process.env.LLM_API_KEY='test';process.env.LLM_BASE_URL='https://model.invalid';process.env.LLM_MODEL='test';}
const {buildLessonMaterial,lessonStructureErrors}=await import('../lib/agents/tutor.ts');
const {buildLessonQualityReport}=await import('../lib/learning-program/quality.ts');
let input;
if(live){
  const {DatabaseSync}=await import('node:sqlite');
  const db=new DatabaseSync(process.env.SQLITE_DATABASE_PATH||'data/growth-loop.sqlite',{readOnly:true});
  const row=db.prepare("SELECT input_json FROM agent_runs WHERE node_name='generate_structured_lesson' ORDER BY created_at DESC LIMIT 1").get();
  if(!row)throw Error('No lesson input available');input=JSON.parse(row.input_json);delete input.groundedContext;db.close();
} else input={goal:{title:'Java',description:'基础'},skill:{id:'s',name:'变量',description:'理解变量'},lesson:{title:'变量',objective:'理解变量',concepts:['变量'],difficulty:1,durationMinutes:30},mastery:{score:0,confidence:0}};
const original=globalThis.fetch;let calls=0;const progress=[];
if(!live)input.lesson.completionEvidence=['解释变量赋值'];
if(!live)globalThis.fetch=async()=>{
  calls++;
  const blocks=[...Array.from({length:4},(_,i)=>({type:'explanation',title:'变量'+i,body:'变量存储值，赋值会改变变量的值。',points:[]})),{type:'guided_practice',title:'练习',prompt:'变量x赋值为1再赋值为2，输出是什么？',completionCriteria:['说明最终输出为2']}];
  if(calls===1)delete blocks[0].body;
  return Response.json({choices:[{message:{content:JSON.stringify({blocks})}}],usage:{prompt_tokens:10,completion_tokens:20,total_tokens:30}});
};
try {
  const result=await buildLessonMaterial(input,async issues=>{progress.push(issues);console.log('REPAIR',JSON.stringify(issues));});
  console.log(JSON.stringify({mode:result.mode,error:result.fallbackReason,validationErrors:result.validationErrors,blocks:result.data.blocks.length,evidenceRequirements:result.data.evidenceRequirements.length,usage:result.usage,quality:live?buildLessonQualityReport({content:result.data}):undefined}));
  assert.equal(result.mode,'llm');assert(result.data.evidenceRequirements.length>0);
  if(!live){assert.equal(calls,2);assert.equal(progress.length,1);assert(progress[0][0].includes('blocks[0].body'));assert.equal(result.usage.totalTokens,60);assert(lessonStructureErrors({blocks:[]})[0].includes('5–12'));}
}finally{globalThis.fetch=original;}
