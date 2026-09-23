// Dedicated browser fixture, never the application database. No model/network calls.
import {registerHooks} from 'node:module';
import {existsSync,mkdtempSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {tmpdir} from 'node:os';
process.env.LLM_PROVIDER='rules';process.env.WORKFLOW_AUTO_WEB='false';process.env.KNOWLEDGE_GATE_MODE='advisory';
process.env.SQLITE_DATABASE_PATH=join(mkdtempSync(join(tmpdir(),'draft-browser-')),'test.sqlite');
registerHooks({resolve(specifier,context,next){
  if(specifier.startsWith('@/')){
    const base=resolve(specifier.slice(2));for(const ext of ['.ts','.tsx','/index.ts'])if(existsSync(base+ext))return next(pathToFileURL(base+ext).href,context);
  }return next(specifier,context);
}});
const {getDatabase}=await import('../lib/db/index.ts');
const {createUserWithStarterData}=await import('../lib/db/users.ts');
const {hashPassword}=await import('../lib/auth/password.ts');
const {createGoalWithProfile}=await import('../lib/db/goals.ts');
const {ensureGoalSkills}=await import('../lib/db/learning-loop.ts');
const {generateCourseForGoal}=await import('../lib/learning-loop/service.ts');
const username='draft_browser_test',password='DraftDemo2026!';
try{
  const user=createUserWithStarterData({username,displayName:'草稿界面验收',passwordHash:await hashPassword(password)});
  const {goal}=createGoalWithProfile({userId:user.id,title:'Java 赋值练习（隔离界面测试）',description:'验证答案保存恢复，不用于教学评测',horizon:'test',selfLevel:'beginner',weeklyHours:3,background:'',targetDate:null});
  ensureGoalSkills(user.id,goal.id,[{key:'assignment',name:'变量赋值',description:'解释值复制',targetLevel:3,weight:1,capabilityType:'conceptual_understanding'}]);
  const program=await generateCourseForGoal(user.id,goal.id,3);
  console.log(JSON.stringify({database:process.env.SQLITE_DATABASE_PATH,username,password,programId:program.programId,lessonId:program.lessons[0].id}));
}finally{getDatabase().close();}
