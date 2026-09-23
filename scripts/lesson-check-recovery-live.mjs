import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {existsSync,mkdtempSync} from 'node:fs';
import {resolve,join,basename,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {DatabaseSync,backup} from 'node:sqlite';
process.loadEnvFile('.env.local');
const source=resolve(process.argv[2]||'');
assert.equal(dirname(dirname(source)).toLowerCase(),resolve(tmpdir()).toLowerCase());
assert(basename(dirname(source)).startsWith('growth-loop-closed-'));
assert.equal(basename(source),'test.sqlite');
const destination=join(mkdtempSync(join(tmpdir(),'growth-check-recovery-')),'test.sqlite');
// SQLite backup includes committed WAL data from a read-only source connection.
const fixture=new DatabaseSync(source,{readOnly:true});
try{await backup(fixture,destination);}finally{fixture.close();}
process.env.SQLITE_DATABASE_PATH=destination;
registerHooks({resolve(specifier,context,next){if(specifier.startsWith('@/')){const base=resolve(specifier.slice(2));for(const ext of ['.ts','.tsx','/index.ts'])if(existsSync(base+ext))return next(pathToFileURL(base+ext).href,context);}return next(specifier,context);}});
const db=new DatabaseSync(destination,{readOnly:true});
const row=db.prepare("SELECT user_id,goal_id,input_json FROM agent_runs WHERE node_name='build_grounded_lesson_check' ORDER BY created_at DESC LIMIT 1").get();
const program=db.prepare('SELECT id FROM learning_programs WHERE goal_id=?').get(row.goal_id);db.close();
const input=JSON.parse(row.input_json);
const {readAuthoredLesson}=await import('../lib/db/programs.ts');
const {materializeNextLesson}=await import('../lib/learning-loop/service.ts');
const {getDatabase}=await import('../lib/db/index.ts');
try {
 const before=readAuthoredLesson(row.user_id,program.id,input.material.lessonId).lesson;
 assert(before.contentVersion.qualityReport.issues.some(x=>x.code==='assessment_generation_failed'));
 const count=()=>getDatabase().prepare("SELECT count(*) n FROM agent_runs WHERE node_name='generate_structured_lesson'").get().n;
 const initialCount=count();
 await materializeNextLesson(row.user_id,program.id,before.id,undefined,progress=>console.log(progress.message));
 const after=readAuthoredLesson(row.user_id,program.id,before.id).lesson;
 assert.equal(after.generationStatus,'ready');assert.equal(after.questions.length,3);
 assert.deepEqual(after.contentVersion.content.blocks,before.contentVersion.content.blocks);
 assert.equal(count(),initialCount,'Must not regenerate approved body');
 assert.equal(after.contentVersion.qualityReport.issues.some(x=>x.code==='assessment_generation_failed'),false);
 console.log('PASS: live assessment-only recovery, unchanged body, three real questions, ready course.');
}finally{getDatabase().close();}
