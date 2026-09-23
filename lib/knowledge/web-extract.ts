import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import ipaddr from 'ipaddr.js';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import { publicWebUrl, WebSourceError } from './web-safety.ts';
import { WEB_LIMITS, deadline, abortable } from './web-timeouts.ts';
import { webProxyUrl, PinnedWebProxyAgent } from './web-proxy.ts';

export function isPublicAddress(address: string) {
  try { return ipaddr.process(address).range() === 'unicast'; } catch { return false; }
}

const MAX_BYTES = 2 * 1024 * 1024;

/** Resolve once, reject mixed private/public answers, pin the validated address for the socket. */
export async function fetchPublicPage(value: string, parent?: AbortSignal): Promise<{ text: string; url: string; type: string }> {
  const total = deadline(WEB_LIMITS.pageMs, 'page_timeout：单网页整体抓取超过 60 秒。', parent);
  try {
    for (let attempt = 0; ; attempt++) {
      try { return await fetchPageHop(value, total.signal, 0, attempt); }
      catch (error) {
        const code = (error as {code?: string})?.code || '';
        // Only idempotent public GET transport failures; never retry security/HTTP/parser failures.
        const retryable = ['ECONNRESET','ETIMEDOUT','ECONNREFUSED','EAI_AGAIN','ENETUNREACH'].includes(code)
          || (error instanceof WebSourceError && error.message.startsWith('connect_timeout：'));
        if (attempt >= 1 || total.signal.aborted || !retryable) throw error;
      }
    }
  }
  catch (error) { if (total.signal.aborted) throw total.signal.reason; throw error; }
  finally { total.dispose(); }
}

async function fetchPageHop(value: string, signal: AbortSignal, redirects: number, attempt: number): Promise<{ text: string; url: string; type: string }> {
  const url = new URL(publicWebUrl(value));
  if (signal.aborted) throw signal.reason;
  const dns = deadline(WEB_LIMITS.dnsMs, 'dns_timeout：域名解析超过 20 秒，尚未连接网站。', signal);
  let addresses: Awaited<ReturnType<typeof lookup>>[];
  try { addresses = await abortable(lookup(url.hostname, { all: true }), dns.signal); }
  finally { dns.dispose(); }
  if (!addresses.length || addresses.some((item) => !isPublicAddress(item.address))) throw new WebSourceError('网页域名解析到非公网地址，已拦截。');
  if (signal.aborted) throw signal.reason;
  const connect = deadline(WEB_LIMITS.connectMs, 'connect_timeout：域名已解析，TCP 连接/TLS 握手超过 10 秒。', signal);
  const hop = new AbortController();
  const abortConnect = () => hop.abort(connect.signal.reason);
  const abortTotal = () => hop.abort(signal.reason);
  connect.signal.addEventListener('abort', abortConnect, { once: true });
  signal.addEventListener('abort', abortTotal, { once: true });
  let responseTimer: ReturnType<typeof setTimeout> | undefined;
  let proxyAgent: PinnedWebProxyAgent | undefined;
  try {
  const ordered = [...addresses].sort((a,b) => a.family - b.family);
  const pinned = ordered[attempt % ordered.length];
  const proxy = webProxyUrl();
  if (proxy) proxyAgent = new PinnedWebProxyAgent(proxy, pinned.address, url.hostname, hop.signal);
  const response = await new Promise<{ status: number; location?: string; data: Buffer; type: string }>((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      agent: proxyAgent || false, signal: hop.signal, family: pinned.family,
      // Keep hostname for Host/SNI and certificate verification; do not resolve it again.
      lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family),
      headers: { 'User-Agent': 'GrowthLoop/0.4 (learning source reader)', Accept: 'text/html,text/plain,text/markdown', 'Accept-Encoding': 'identity' },
    }, (res) => {
      clearTimeout(responseTimer);
      const status = res.statusCode || 0;
      const type = String(res.headers['content-type'] || '').toLowerCase();
      if ([301, 302, 303, 307, 308].includes(status)) {
        res.destroy(); resolve({ status, location: res.headers.location, data: Buffer.alloc(0), type }); return;
      }
      if (status < 200 || status >= 300) { res.destroy(); reject(new WebSourceError(`网页返回 HTTP ${status}，请换一个公开来源。`, 502)); return; }
      if (!/^(text\/html|application\/xhtml\+xml|text\/plain|text\/markdown)(;|$)/.test(type)
        || (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity')) {
        res.destroy(); reject(new WebSourceError('当前只支持未压缩 HTML/TXT/Markdown 网页，请换来源或上传文件。')); return;
      }
      let size = 0;
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BYTES) { res.destroy(new WebSourceError('网页正文超过 2 MB 抓取安全上限。')); return; }
        chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => resolve({ status, data: Buffer.concat(chunks), type }));
    });
    request.on('socket', socket => {
      const connected = () => {
        connect.dispose();
        connect.signal.removeEventListener('abort', abortConnect);
        responseTimer = setTimeout(() => hop.abort(new WebSourceError('first_response_timeout：连接成功，但等待响应头超过 30 秒。', 504)), WEB_LIMITS.firstResponseMs);
      };
      if (proxyAgent && url.protocol === 'http:') connected();
      else socket.once(url.protocol === 'https:' ? 'secureConnect' : 'connect', connected);
    });
    request.on('error', error => reject(hop.signal.aborted ? hop.signal.reason : error));
    request.end();
  });
  if (response.location) {
    if (redirects >= 3) throw new WebSourceError('网页重定向次数过多。');
    const next = new URL(response.location, url);
    if (url.protocol === 'https:' && next.protocol !== 'https:') throw new WebSourceError('不允许网页降级为非加密连接。');
    return fetchPageHop(next.href, signal, redirects + 1, attempt);
  }
  if (response.status >= 300) throw new WebSourceError('网页重定向缺少目标地址。');
  const charset = response.type.match(/charset=["']?([^;"'\s]+)/)?.[1] || 'utf-8';
  let text: string;
  try { text = new TextDecoder(charset).decode(response.data); }
  catch { throw new WebSourceError('不支持这个网页的字符编码。'); }
  return { text, url: url.href, type: response.type };
  } catch (error) {
    if (hop.signal.aborted) throw hop.signal.reason;
    throw error;
  } finally {
    clearTimeout(responseTimer); connect.dispose();
    proxyAgent?.destroy();
    connect.signal.removeEventListener('abort', abortConnect);
    signal.removeEventListener('abort', abortTotal);
  }
}

export function htmlToArticleMarkdown(html: string, url: string) {
  const { document } = parseHTML(html);
  if (document.querySelectorAll('*').length > 40000) throw new WebSourceError('网页结构过于复杂，请换来源。');
  for (const element of document.querySelectorAll('script,style,noscript,iframe,form,svg,canvas,nav,footer,base')) element.remove();
  for (const element of document.querySelectorAll('a[href]')) {
    try { element.setAttribute('href', publicWebUrl(new URL(element.getAttribute('href') || '', url).href)); }
    catch { element.removeAttribute('href'); }
  }
  for (const element of document.querySelectorAll('img,video,audio,object,embed')) element.remove();
  const article = new Readability(document as unknown as Document, { charThreshold: 100, maxElemsToParse: 40000 }).parse();
  if (!article?.content || (article.textContent?.trim().length || 0) < 100) throw new WebSourceError('未提取到足够正文，网页可能需要登录或依赖 JavaScript。');
  const converter = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  // Retain table cell relationships instead of flattening an entire table into prose.
  converter.addRule('table', { filter: 'table', replacement: (_content, node) => {
    const rows = Array.from((node as HTMLTableElement).rows).map((row) => Array.from(row.cells).map((cell) => (cell.textContent || '').trim().replace(/\s+/g, ' ').replace(/\|/g, '\\|')));
    const width = Math.max(0, ...rows.map((row) => row.length));
    if (!width) return '';
    const lines = rows.map((row) => '| ' + Array.from({ length: width }, (_, i) => row[i] || '').join(' | ') + ' |');
    lines.splice(1, 0, '| ' + Array(width).fill('---').join(' | ') + ' |');
    return '\n\n' + lines.join('\n') + '\n\n';
  } });
  return converter.turndown(article.content).trim();
}

export async function extractPublicWeb(url: string, signal?: AbortSignal) {
  try {
    const page = await fetchPublicPage(url, signal);
    const markdown = /^(text\/plain|text\/markdown)/.test(page.type) ? page.text.trim() : htmlToArticleMarkdown(page.text, page.url);
    if (markdown.length < 100) throw new WebSourceError('网页正文不足，无法作为教学资料。');
    return markdown;
  } catch (error) {
    if (error instanceof WebSourceError) throw error;
    const code = (error as { code?: string })?.code;
    throw new WebSourceError(`公开网页连接或下载失败（${code && /^[A-Z0-9_]+$/.test(code) ? code : 'transport_error'}），请重试或选择其他来源。`, 502);
  }
}
