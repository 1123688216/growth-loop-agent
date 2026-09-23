// Explicit account-scoped repair; no grading or course content changes.
import {getDatabase,withTransaction} from '../lib/db/index.ts';
import {syncCourseTasks} from '../lib/db/course-tasks.ts';
const username=process.argv[2];
if(!username)throw Error('Usage: node --env-file=.env.local scripts/sync-course-tasks.mjs USERNAME');
const db=getDatabase();
const user=db.prepare('SELECT id FROM users WHERE username=?').get(username);
if(!user)throw Error('Account not found');
withTransaction(transaction=>{
  for(const program of transaction.prepare('SELECT id FROM learning_programs WHERE user_id=?').all(user.id))syncCourseTasks(transaction,user.id,program.id);
});
console.log(JSON.stringify(db.prepare('SELECT t.title,t.status,t.goal_id,l.lesson_id FROM tasks t JOIN task_lesson_links l ON l.task_id=t.id WHERE t.user_id=?').all(user.id)));
