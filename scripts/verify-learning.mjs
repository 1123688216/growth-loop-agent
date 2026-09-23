import {spawnSync} from 'node:child_process';
// Fixed, local, isolated/mock test list; no live providers and no application database mutations.
const tests=['llm-transport-smoke','planner-structure-smoke','lesson-structure-smoke','lesson-contract-smoke',
  'evidence-review-smoke','knowledge-gate-smoke','web-sources-smoke','deepseek-search-smoke','web-timeouts-smoke',
  'course-regeneration-smoke','grade-next-lesson-smoke','learning-loop-isolated',
  'assessment-integrity-smoke','semantic-review-recovery-smoke','quality-details-render-smoke','answer-drafts-smoke','web-proxy-smoke',
  'v044-rag-tool-smoke','ragflow-smoke','question-text-render-smoke'];
const failed=[];
for(const name of tests){
  console.log(`\n[CHECK] ${name}`);
  const run=spawnSync(process.execPath,['--experimental-strip-types',`scripts/${name}.mjs`],{stdio:'inherit',timeout:120000});
  if(run.status!==0){failed.push(name);if(run.error)console.error(run.error.message);}
}
console.log(`\n${tests.length-failed.length}/${tests.length} suites passed${failed.length?'; failed: '+failed.join(', '):''}`);
process.exitCode=failed.length?1:0;
