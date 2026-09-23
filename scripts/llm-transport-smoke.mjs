import assert from 'node:assert/strict';
import { requestStructured, describeFailure } from '../lib/agents/shared.ts';
process.env.LLM_PROVIDER = 'test';
process.env.LLM_API_KEY = 'test-only';
process.env.LLM_BASE_URL = 'https://example.invalid';
process.env.LLM_MODEL = 'test';
const original = globalThis.fetch;
const input = { system: 'test', user: 'test', fallback: { ok: false }, normalize: (r) => r };
try {
  let calls = 0;
  let firstSignal;
  globalThis.fetch = async (_url, options) => {
    calls++;
    if (calls === 1) { firstSignal = options.signal; throw new TypeError('fetch failed', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }); }
    assert.equal(options.signal, firstSignal);
    return Response.json({ choices: [{ message: { content: '{"ok":true}' } }] });
  };
  assert.equal((await requestStructured(input)).mode, 'llm');
  assert.equal(calls, 2);
  calls = 0;
  globalThis.fetch = async () => { calls++; throw new DOMException('timeout', 'TimeoutError'); };
  assert.equal((await requestStructured(input)).fallbackReason, 'timeout_60000ms');
  assert.equal(calls, 1);
  calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('', { status: 401 }); };
  assert.equal((await requestStructured(input)).fallbackReason, 'http_401');
  assert.equal(calls, 1);
  assert.equal(describeFailure(new Error('secret URL or credential'), 60000), 'request_failed');
  globalThis.fetch = async () => { throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }); };
  assert.equal((await requestStructured(input)).fallbackReason, 'network_ECONNRESET');
  calls=0;const notices=[];
  globalThis.fetch=async (_url,options)=>{
    calls++;const payload=JSON.parse(options.body);
    if(calls===2) assert(payload.messages.at(-1).content.includes('blocks[0].body'));
    return Response.json({choices:[{message:{content:JSON.stringify({ok:calls===2})}}],usage:{prompt_tokens:10,completion_tokens:20,total_tokens:30}});
  };
  const repaired=await requestStructured({...input,normalize:raw=>raw.ok?raw:null,repairValidation:true,
    validationIssues:()=>['blocks[0].body: 需要正文'],onValidationRepair:async errors=>notices.push(errors)});
  assert.equal(repaired.mode,'llm');assert.equal(calls,2);assert.equal(notices.length,1);assert.equal(repaired.usage.totalTokens,60);
  calls=0;globalThis.fetch=async()=>{calls++;return Response.json({choices:[{message:{content:'{"ok":false}'}}]});};
  const failed=await requestStructured({...input,normalize:()=>null,repairValidation:true,validationIssues:()=>['blocks: 缺失']});
  assert.equal(calls,2);assert.equal(failed.fallbackReason,'validation_failed');assert.deepEqual(failed.validationErrors,['blocks: 缺失']);
  calls=0;globalThis.fetch=async()=>{
    calls++;if(calls===1)throw new TypeError('fetch failed',{cause:{code:'EAI_AGAIN'}});
    return Response.json({choices:[{message:{content:JSON.stringify({ok:calls===3})}}]});
  };
  assert.equal((await requestStructured({...input,normalize:r=>r.ok?r:null,repairValidation:true})).mode,'llm');
  assert.equal(calls,3,'one connection retry must not consume one validation repair');
  console.log('PASS: bounded pre-connect retry, shared deadline, no timeout/auth replay, redacted errors.');
} finally { globalThis.fetch = original; }
