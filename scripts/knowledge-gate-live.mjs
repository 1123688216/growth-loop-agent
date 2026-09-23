import assert from 'node:assert/strict';
import {mkdirSync,appendFileSync} from 'node:fs';
import {resolve} from 'node:path';

if(!process.argv.includes('--live')) throw new Error('--live creates a test account and calls the configured models.');
const stamp=Date.now();
mkdirSync('.runtime',{recursive:true});
const report=resolve('.runtime',`knowledge-gate-live-${stamp}.jsonl`);
function log(event){const line=JSON.stringify({...event,at:new Date().toISOString()});console.log(line);appendFileSync(report,line+'\n');}
const base='http://127.0.0.1:3000';
let cookie='';
async function post(path,body){return fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(600000)});}
async function prepare(goalId) {
  const response=await post('/api/learning-program',{action:'prepare-stream',goalId});
  assert(response.ok,`prepare HTTP ${response.status}`);
  let pending='',result;
  for await(const chunk of response.body.pipeThrough(new TextDecoderStream())) {
    pending+=chunk;
    let index;
    while((index=pending.indexOf('\n'))>=0) {
      const line=pending.slice(0,index);pending=pending.slice(index+1);if(!line)continue;
      const event=JSON.parse(line);
      if(event.type==='progress')log({stage:'prepare',...event.progress});
      if(event.type==='error')throw Error(event.error);
      if(event.type==='result')result=event.preparation;
    }
  }
  assert(result,'stream ended without terminal result');
  return result;
}
try {
  const username=`gate_live_${stamp}`;
  const registration=await post('/api/auth/register',{username,password:crypto.randomUUID(),displayName:'Knowledge Gate 流程验证'});
  const account=await registration.json();assert(registration.ok,account.error);
  cookie=registration.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
  const created=await post('/api/goals',{title:'Java 引用值赋值与 null',description:'只学习 Java 引用值的赋值、与 null 比较，使用一个短例子，不扩展为整个 Java 路线。',selfLevel:'beginner',weeklyHours:2});
  const goal=await created.json();assert(created.ok,goal.error);
  log({stage:'created_test_goal',username,userId:account.user.id,goalId:goal.goal.id,report});
  const first=await prepare(goal.goal.id);
  log({stage:'first_result',nextAction:first.nextAction,sourceWait:first.sourceWait});
  assert.equal(first.nextAction,'sources','An empty test library must pause for source selection');
  const candidatesResponse=await fetch(base+'/api/web-sources?goalId='+goal.goal.id,{headers:{Cookie:cookie}});
  const candidates=await candidatesResponse.json();
  log({stage:'candidate_preview',...candidates});
  const again=await prepare(goal.goal.id);
  assert.equal(again.nextAction,'sources','Reload must preserve waiting state');
  const after=await(await fetch(base+'/api/web-sources?goalId='+goal.goal.id,{headers:{Cookie:cookie}})).json();
  assert.deepEqual(after.knowledgeGate,candidates.knowledgeGate,'Reload must not replenish or consume gate budgets');
  log({stage:'waiting_verified',candidateCount:candidates.candidates.length,budgets:after.knowledgeGate});
  assert(candidates.candidates.length>0,'Waiting state works, but real search returned no selectable candidates');
  log({stage:'finished',message:'API waiting and replay verified; no source selected or imported by this script.'});
} catch(error) {log({stage:'failed',message:error.message});process.exitCode=1;}
