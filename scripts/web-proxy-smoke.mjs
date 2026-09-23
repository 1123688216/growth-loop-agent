import assert from 'node:assert/strict';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { webApiFetch, webProxyUrl, PinnedWebProxyAgent } from '../lib/knowledge/web-proxy.ts';
const originalFetch = globalThis.fetch;
const originalProxy = process.env.WEB_HTTP_PROXY;
const originalGlobalProxy = process.env.HTTPS_PROXY;
const originalConnect = HttpsProxyAgent.prototype.connect;
try {
  delete process.env.WEB_HTTP_PROXY;
  let options;
  globalThis.fetch = async (_url, init) => { options = init; return Response.json({ok:true}); };
  await webApiFetch('https://api.tavily.com/search', {method:'POST'});
  assert.equal(options.dispatcher, undefined);
  process.env.WEB_HTTP_PROXY = 'http://127.0.0.1:7890';
  await webApiFetch('https://api.tavily.com/search', {method:'POST'});
  assert(options.dispatcher);
  assert.equal(process.env.HTTPS_PROXY, originalGlobalProxy, 'must not set a global proxy');
  assert.throws(()=>webApiFetch('http://127.0.0.1:8010/health', {}), /未授权/);
  for(const value of ['socks5://localhost:7890','http://user:secret@localhost:7890','http://localhost:7890/path']) {
    process.env.WEB_HTTP_PROXY=value;assert.throws(webProxyUrl,/配置无效/);
  }
  let connected;
  HttpsProxyAgent.prototype.connect = async (_req, opts) => { connected=opts; return null; };
  const agent=new PinnedWebProxyAgent('http://127.0.0.1:7890','8.8.8.8','docs.example.com',new AbortController().signal);
  await agent.connect({}, {host:'docs.example.com',port:443,secureEndpoint:true});
  assert.equal(connected.host,'8.8.8.8');assert.equal(connected.servername,'docs.example.com');
  assert.notEqual(connected.rejectUnauthorized,false);
  agent.destroy();
  console.log('PASS: scoped proxy, direct mode, API origin restriction, sanitized config, pinned CONNECT IP and original TLS hostname.');
} finally {
  globalThis.fetch=originalFetch;HttpsProxyAgent.prototype.connect=originalConnect;
  if(originalProxy===undefined)delete process.env.WEB_HTTP_PROXY;else process.env.WEB_HTTP_PROXY=originalProxy;
}
