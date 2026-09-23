import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import dns from 'node:dns/promises';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { WEB_LIMITS } from '../lib/knowledge/web-timeouts.ts';
assert.deepEqual(WEB_LIMITS, {dnsMs:20000,connectMs:10000,firstResponseMs:30000,pageMs:60000,batchSize:3});
// Short real timers exercise the exact production phase wiring without external I/O.
Object.assign(WEB_LIMITS,{dnsMs:60,connectMs:30,firstResponseMs:40,pageMs:180});
const oldLookup=dns.lookup, oldRequest=https.request;
let mode='ok';
let requests=0;
dns.lookup=async()=>{
  if(mode==='dnsTimeout') return new Promise(()=>{});
  if(mode==='dnsSlow') await new Promise(r=>setTimeout(r,40));
  return [{address:'93.184.216.34',family:4},{address:'93.184.216.35',family:4}];
};
https.request=(_url,options,onResponse)=>{
  const req=new EventEmitter(); const socket=new EventEmitter(); const timers=[];
  const later=(fn,ms)=>timers.push(setTimeout(fn,ms));
  const cleanup=()=>{timers.forEach(clearTimeout);options.signal.removeEventListener('abort',abort);};
  const abort=()=>{cleanup();req.emit('error',new Error('aborted transport'));};
  options.signal.addEventListener('abort',abort,{once:true});
  req.end=()=>{
    requests++;
    req.emit('socket',socket);
    if(mode==='reset' && requests===1) {later(()=>{cleanup();req.emit('error',Object.assign(new Error('reset'),{code:'ECONNRESET'}));},3);return;}
    if(mode==='connect') return;
    later(()=>{
      socket.emit('secureConnect');
      if(mode==='first') return;
      later(()=>{
        const res=new EventEmitter();res.statusCode=mode==='forbidden'?403:200;res.headers={'content-type':'text/plain'};
        res.destroy=(error)=>{cleanup();if(error)res.emit('error',error);};
        onResponse(res);
        later(()=>{res.emit('data',Buffer.from('Valid source text. '.repeat(20)));cleanup();res.emit('end');},mode==='body'?200:3);
      },3);
    },3);
  };
  return req;
};
syncBuiltinESMExports();
try {
  const {fetchPublicPage}=await import('../lib/knowledge/web-extract.ts');
  assert((await fetchPublicPage('https://example.com')).text.length>100);
  mode='dnsSlow';assert((await fetchPublicPage('https://example.com')).text.length>100,'DNS taking longer than connection timeout must succeed');
  mode='reset';requests=0;assert((await fetchPublicPage('https://example.com')).text.length>100);assert.equal(requests,2);
  mode='forbidden';requests=0;await assert.rejects(fetchPublicPage('https://example.com'),/HTTP 403/);assert.equal(requests,1);
  for(const [scenario,code] of [['dnsTimeout','dns_timeout'],['connect','connect_timeout'],['first','first_response_timeout'],['body','page_timeout']]){
    mode=scenario;await assert.rejects(fetchPublicPage('https://example.com'),new RegExp(code));
  }
  mode='ok';
  for(let i=0;i<3;i++) assert((await fetchPublicPage('https://example.com')).text.length>100,'Previous timeout cannot consume another page deadline');
  console.log('PASS: production limits, individual page timeouts, independent subsequent requests, no shared batch deadline.');
} finally {
  dns.lookup=oldLookup;https.request=oldRequest;syncBuiltinESMExports();
}
