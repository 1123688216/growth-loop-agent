import assert from 'node:assert/strict';
import { isPublicAddress, htmlToArticleMarkdown, extractPublicWeb } from '../lib/knowledge/web-extract.ts';
import { publicWebUrl } from '../lib/knowledge/web-safety.ts';
for (const ip of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1', '172.16.0.1', '100.64.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '198.18.0.1']) assert.equal(isPublicAddress(ip), false, ip);
assert.equal(isPublicAddress('8.8.8.8'), true);
for (const url of ['http://127.1', 'http://[::1]', 'file:///etc/passwd', 'https://a:b@example.com', 'http://localhost', 'https://example.com:6000']) assert.throws(() => publicWebUrl(url));
const html = '<html><head><title>Java types</title></head><body><nav>UNWANTED NAV</nav><article><h1>Java types</h1><p>' + 'Java has primitive types and reference types. Reference variables can contain null, but int cannot. '.repeat(8) + '</p><pre><code>int count = 1;</code></pre><table><tr><th>Type</th><th>Example</th></tr><tr><td>int</td><td>1</td></tr></table><script>UNWANTED SCRIPT</script></article></body></html>';
const md = htmlToArticleMarkdown(html, 'https://example.com/java');
assert(md.includes('int count = 1;')); assert(md.includes('| int | 1 |')); assert(!md.includes('UNWANTED'));
console.log('PASS: public address filtering, URL rejection, article/code/table extraction, script removal.');
if (process.argv.includes('--live')) {
  const started = performance.now();
  const live = await extractPublicWeb('https://docs.oracle.com/javase/tutorial/java/nutsandbolts/datatypes.html');
  assert(live.includes('int') && live.length > 500);
  console.log(JSON.stringify({ live: 'Oracle Java tutorial extracted', characters: live.length, ms: Math.round(performance.now()-started) }));
}
