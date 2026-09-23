import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
process.env.LLM_PROVIDER='fixture';process.env.LLM_API_KEY='test';process.env.LLM_BASE_URL='https://fixture.invalid';process.env.LLM_MODEL='fixture';
registerHooks({resolve(specifier,context,next){
  if(specifier.startsWith('@/')){
    const base=resolve(specifier.slice(2));
    for(const ext of ['.ts','.tsx','/index.ts'])if(existsSync(base+ext))return next(pathToFileURL(base+ext).href,context);
  }
  return next(specifier,context);
}});
const {buildLessonMaterial,repairLessonMaterial,buildLessonCheck}=await import('../lib/agents/tutor.ts');
const input={goal:{title:'Java',description:'Java基础'},skill:{id:'s',name:'集合与String',description:'学习集合与String'},
  lesson:{title:'集合与String',objective:'学习集合与String',concepts:['集合','String'],difficulty:2,durationMinutes:45,capabilityType:'conceptual_understanding',completionEvidence:['完成String不可变性输出题，提交五段代码和三段录音']},mastery:{score:0,confidence:0}};
const code='```java\nint value = 1; // 初始值\nvalue = 2;\nSystem.out.println(value);\n```';
const payload={title:'变量赋值',objective:'解释赋值结果',estimatedMinutes:30,sourceStatus:'grounded',sourceRefs:['invented'],
  blocks:[
    {type:'explanation',title:'赋值概念',body:'赋值会将右侧的值保存到左侧变量。\n请先判断最后一次赋值的位置。'},
    {type:'case_study',title:'赋值实例',scenario:'对同一个整数变量依次赋值',steps:[code,'对照最后一次赋值检查输出'],result:'输出2',verification:'运行并观察输出2'},
    {type:'common_mistake',title:'避免误读',body:'打印读取的是当前值，不是变量第一次获得的值。'},
    {type:'guided_practice',title:'练习',prompt:'将最后一次赋值改为3，预测输出并运行核对。',completionCriteria:['预测输出3','运行结果与预测一致']},
    {type:'summary',title:'小结',body:'通过定位最后一次赋值，解释输出结果。'},
  ],evidenceRequirements:[{type:'procedure',description:'提交当前赋值练习的运行输出',successCriteria:['输出3并解释原因']}],modelSummary:'只检验当前赋值练习'};
const original=globalThis.fetch;let raw=payload,calls=0;
globalThis.fetch=async()=>{calls++;return Response.json({choices:[{message:{content:JSON.stringify(raw)}}]});};
try {
  const first=await buildLessonMaterial(input);assert.equal(first.mode,'llm');assert.equal(calls,1);
  assert.equal(first.data.blocks[1].type,'worked_example');assert.equal(first.data.blocks[1].steps[0],code);
  assert(first.data.blocks[0].body.includes('\n'));
  assert.equal(first.data.sourceStatus,'unverified');assert.deepEqual(first.data.sourceRefs,[]);
  const stale={...first.data,evidenceRequirements:[{id:'old',objectiveId:'lesson-objective',type:'artifact',description:'String不可变性题',successCriteria:['五段代码三段录音']}]};
  const repaired=await repairLessonMaterial(input,stale,[]);assert.equal(repaired.mode,'llm');
  assert.equal(repaired.data.evidenceRequirements[0].description,payload.evidenceRequirements[0].description);
  assert.deepEqual(repaired.data.evidenceRequirements[0].successCriteria,['输出3并解释原因']);
  assert(!JSON.stringify(repaired.data.evidenceRequirements).includes('String'));
  assert.notEqual(repaired.data.contentVersionId,first.data.contentVersionId);
  assert.equal(repaired.data.estimatedMinutes,30);
  const withoutRequirements={...payload};delete withoutRequirements.evidenceRequirements;raw=withoutRequirements;
  const derived=await repairLessonMaterial(input,stale,[]);
  assert.equal(derived.mode,'llm');assert.equal(derived.data.evidenceRequirements[0].description,payload.blocks[3].prompt);
  assert(!JSON.stringify(derived.data.evidenceRequirements).includes('String'));
  raw={...payload,evidenceRequirements:[{description:'缺少评分标准'}]};calls=0;
  assert.equal((await repairLessonMaterial(input,stale,[])).mode,'rules');assert.equal(calls,2,'invalid requirements get one repair only');
  raw={...payload,blocks:payload.blocks.map((block,i)=>i===1?{...block,verification:''}:block)};calls=0;
  assert.equal((await buildLessonMaterial(input)).mode,'rules');assert.equal(calls,2,'incomplete examples are not silently passed');
  raw={questions:[]};calls=0;
  const questions=await buildLessonCheck({...input,material:first.data});
  assert.equal(questions.mode,'rules');assert.equal(questions.fallbackReason,'validation_failed');assert.equal(calls,2);
  const longPrompt='请阅读完整代码并解释输出。\n\n```java\n'+('int value = 1; // 保留换行\n'.repeat(50))+'System.out.println(value);\n```\n\n说明最终结果。';
  raw={questions:questions.data.map(q=>({...q,prompt:longPrompt}))};
  const longResult=await buildLessonCheck({...input,material:first.data});
  assert.equal(longResult.mode,'llm');assert.equal(longResult.data[0].prompt,longPrompt,'long code question must not be truncated at 800');
  raw={questions:questions.data.map(q=>({...q,prompt:'x'.repeat(12001)}))};calls=0;
  assert.equal((await buildLessonCheck({...input,material:first.data})).mode,'rules');assert.equal(calls,2,'oversize is repaired/rejected, not sliced');
  raw={questions:questions.data.map(q=>({...q,prompt:'```java\nint x = 1;'}))};
  assert.equal((await buildLessonCheck({...input,material:first.data})).mode,'rules','unclosed fenced code cannot pass');
  console.log('PASS: complete case-study compatibility, code newlines, shared generation/repair contract, revised requirements retained, stale requirements not resurrected, bounded invalid-output repair and honest question failure.');
}finally{globalThis.fetch=original;}
