import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
process.env.LLM_PROVIDER='test'; process.env.LLM_API_KEY='fixture';
process.env.LLM_BASE_URL='https://fixture.invalid'; process.env.LLM_MODEL='fixture';
registerHooks({resolve(specifier,context,next){
  if(specifier.startsWith('@/')){
    const base=resolve(specifier.slice(2));
    for(const ext of ['.ts','.tsx','/index.ts'])if(existsSync(base+ext))return next(pathToFileURL(base+ext).href,context);
  }
  return next(specifier,context);
}});
const {buildCourseOutline,buildSkillMap}=await import('../lib/agents/planner.ts');
const goal={id:'g',title:'我想学习Java技术',description:'能写简单程序',selfLevel:'familiar',background:'认识变量，尚不熟悉循环',weeklyHours:4,targetDate:null};
const skills=[{id:'s',name:'基本编程能力',description:'实现并验证简单程序',capabilityType:'procedural_skill',targetLevel:3,weight:1}];
const valid={title:'Java 入门',lessons:['变量与赋值','条件分支','循环与累加'].map(title=>({title,objective:'预测短程序输出并解释执行步骤',skillId:'s'}))};
const originalFetch=globalThis.fetch; let replies=[],calls=[];
globalThis.fetch=async(_url,options)=>{
  calls.push(JSON.parse(options.body));
  assert(replies.length,'Unexpected model call');
  return Response.json({choices:[{message:{content:JSON.stringify(replies.shift())}}]});
};
try{
  for(const invalid of [
    {lessons:[]},
    {...valid,lessons:[...valid.lessons,{...valid.lessons[0]}]},
    {...valid,lessons:valid.lessons.map(lesson=>({...lesson,title:''}))},
    {...valid,lessons:valid.lessons.map(lesson=>({...lesson,title:goal.title+'的核心方法'}))},
    {...valid,lessons:valid.lessons.map(lesson=>({...lesson,skillId:'foreign'}))},
  ]){
    replies=[invalid,valid];calls=[];const progress=[];
    const result=await buildCourseOutline(goal,skills,3,async issues=>{progress.push(issues)});
    assert.equal(result.mode,'llm');assert.equal(calls.length,2);assert.equal(progress.length,1);
    assert.equal(result.data.lessons[0].title,'变量与赋值');
    assert(calls[0].messages[1].content.includes(goal.background));
    assert(calls[0].messages[1].content.includes(goal.selfLevel));
  }
  replies=[{lessons:[]},{lessons:[]}];calls=[];
  const failed=await buildCourseOutline(goal,skills,3);
  assert.equal(failed.mode,'rules');assert.equal(failed.fallbackReason,'validation_failed');assert.equal(calls.length,2);
  replies=[{skills:[]}];calls=[];
  const failedSkills=await buildSkillMap(goal);
  assert.equal(failedSkills.mode,'rules');assert.equal(failedSkills.fallbackReason,'validation_failed');
  console.log('PASS: invalid planner JSON/template titles are not mislabeled as successful planning; one bounded repair; saved background and self level included.');
}finally{globalThis.fetch=originalFetch;}
