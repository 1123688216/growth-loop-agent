import assert from "node:assert/strict";
import { searchWeb } from "../lib/knowledge/web-provider.ts";
process.env.WEB_SEARCH_PROVIDER = "deepseek";
process.env.DEEPSEEK_API_KEY = "test-key";
let searched = true;
let incomplete = false;
globalThis.fetch = async (url, options) => {
  assert.equal(url, "https://api.deepseek.com/responses");
  const body = JSON.parse(options.body);
  assert.deepEqual(body.tools, [{ type: "web_search" }]);
  assert.deepEqual(body.tool_choice, { type: "web_search" });
  return Response.json({ status: incomplete ? "incomplete" : "completed", output: [
    ...(searched ? [{ type: "web_search_call", status: "completed" }] : []),
    { type: "reasoning", content: [{ type: "reasoning_text", text: "must not parse this" }] },
    { type: "message", content: [{ type: "output_text", text: JSON.stringify({ results: [
      { url: "https://example.com/doc", title: "Doc", content: "Candidate description" },
      { url: "https://example.com/doc#duplicate" }, { url: "http://127.0.0.1/private" },
    ] }) }] },
  ] });
};
assert.equal((await searchWeb("transaction")).length, 1);
searched = false;
await assert.rejects(() => searchWeb("x"), /未返回已完成/);
searched = true; incomplete = true;
await assert.rejects(() => searchWeb("x"), /未返回已完成/);
const successfulFetch = globalThis.fetch;
incomplete = false;
let calls = 0;
globalThis.fetch = async (...args) => {
  if (++calls === 1) throw new TypeError('fetch failed', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });
  return successfulFetch(...args);
};
assert.equal((await searchWeb('retry')).length, 1);
assert.equal(calls, 2);
calls = 0;
globalThis.fetch = async () => { calls++; throw new TypeError('fetch failed', { cause: { code: 'UND_ERR_SOCKET' } }); };
await assert.rejects(() => searchWeb('no replay'), /network_UND_ERR_SOCKET/);
assert.equal(calls, 1);
globalThis.fetch = successfulFetch;
delete process.env.DEEPSEEK_API_KEY;
process.env.LLM_API_KEY = "other-provider-key";
process.env.LLM_BASE_URL = "https://other.example.com";
await assert.rejects(() => searchWeb("x"), /DEEPSEEK_API_KEY/);
console.log(JSON.stringify({ ok: true, actualSearchRequired: true, incompleteRejected: true, credentialsIsolated: true, unsafeUrlsRejected: true }));
