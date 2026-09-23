// Opt-in, real provider calls and test-account records. Never reads grading answers from DB.
import { readFileSync } from 'node:fs';
if (!process.argv.includes('--live')) throw Error('Requires --live (creates test learning records and calls configured models).');
const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:3010';
if (!['127.0.0.1','localhost'].includes(new URL(base).hostname)) throw Error('Local test only');
const password = process.env.TEST_LOGIN_PASSWORD;
if (!password) throw Error('Set TEST_LOGIN_PASSWORD');
const args = process.argv.slice(2).filter(x => x !== '--live');
const [stage, id, lessonId, answerFile] = args;
const login = await fetch(base + '/api/auth/login', {method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({username:'test',password}), signal:AbortSignal.timeout(15000)});
if (!login.ok) throw Error(`Login ${login.status}`);
const headers = {'Content-Type':'application/json', Cookie:login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ')};
async function call(path, body, method = 'POST') {
  const response = await fetch(base+path,{method,headers,body:body === undefined ? undefined : JSON.stringify(body),signal:AbortSignal.timeout(900000)});
  if (!response.ok) throw Error(`${response.status}: ${await response.text()}`);
  if(response.headers.get('content-type')?.includes('ndjson')) {
    let buffer=''; let last; const decoder = new TextDecoder();
    for await(const data of response.body) {
      buffer+=decoder.decode(data, {stream:true});
      let end;
      while((end=buffer.indexOf('\n'))>=0) {
        const line=buffer.slice(0,end); buffer=buffer.slice(end+1);
        if(!line.trim())continue;
        const event=JSON.parse(line);last=event;
        console.log(JSON.stringify(event.type==='progress'?event:{type:event.type,error:event.error,
          nextAction:event.preparation?.nextAction,program:summary(event.program||event.preparation?.program)}));
      }
    }
    if (last?.type === 'error' || last?.type === 'needs_sources') throw Error(last.error || last.type);
    if (last?.type !== 'result') throw Error('Stream ended without a result');
    return last;
  }
  return response.json();
}
function summary(p) {return p && {programId:p.programId,title:p.title,lessons:p.lessons?.map(l=>({id:l.id,title:l.title,generationStatus:l.generationStatus,qualityStatus:l.qualityStatus,sourceStatus:l.sourceStatus,questions:l.questions?.length,issues:l.qualityReport?.issues}))};}
if(stage==='create') {
  const created=await call('/api/goals',{title:'Agent 工具调用与 ReAct 循环（闭环验收）',
    description:'学习 Agent 的工具调用、ReAct 中的思考—行动—观察循环，能解释具体运行轨迹、识别工具输入和观察结果，并说明工具失败后的处理。不涉及框架安装或代码实作，只做概念理解与纸面场景分析。',
    background:'初学者，理解普通聊天机器人；希望先掌握工具调用和 ReAct 的基础。',selfLevel:'beginner',weeklyHours:2});
  console.log(JSON.stringify({stage:'created',goalId:created.goal.id}));
  const sources=await call('/api/knowledge-sources',undefined,'GET');
  const source=sources.sources.find(s=>s.chunkStrategy==='ragflow');if(!source)throw Error('No RAGFlow source');
  await call(`/api/goals/${created.goal.id}/sources`,{mode:'selected',includedSourceIds:[source.id]},'PUT');
  await call('/api/learning-program',{action:'prepare-stream',goalId:created.goal.id});
} else if(stage==='prepare') {
  await call('/api/learning-program',{action:'prepare-stream',goalId:id});
} else if(stage==='show') {
  console.log(JSON.stringify(await call('/api/learning-program?program='+encodeURIComponent(id),undefined,'GET')));
} else if(stage==='questions') {
  const result = await call('/api/learning-program?program='+encodeURIComponent(id),undefined,'GET');
  const lesson = result.program.lessons.find(l=>l.id===lessonId);
  console.log(JSON.stringify({questions:lesson.questions,example:lesson.example,practice:lesson.practice}));
} else if(stage==='retry') {
  await call('/api/learning-program',{action:'retry-lesson-stream',programId:id,lessonId});
} else if(stage==='tutor') {
  console.log(JSON.stringify(await call('/api/learning-program',{action:'tutor',programId:id,lessonId,
    message:'为什么模型发出工具调用请求不等于已经执行了工具？请基于指定教材和本节内容解释 Agent 框架的职责，并标注依据。'})));
} else if(stage==='grade') {
  const answers=JSON.parse(readFileSync(answerFile,'utf8'));
  const result=await call('/api/learning-program',{action:'grade',programId:id,lessonId,answers,deferNextLesson:true});
  const g=result.grade;
  console.log(JSON.stringify({grade:{score:g.score,passed:g.passed,level:g.level,gradedBy:g.gradedBy,
    nextLessonId:g.nextLessonId,mastery:g.mastery},lessons:result.program?.lessons.map(l=>({id:l.id,status:l.status,generationStatus:l.generationStatus})),warning:result.nextLessonWarning}));
} else throw Error('Stages: create / prepare GOAL / show PROGRAM / retry PROGRAM LESSON / tutor PROGRAM LESSON / grade PROGRAM LESSON ANSWERS_JSON');
