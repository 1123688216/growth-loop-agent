import { ProxyAgent } from 'undici';
import { HttpsProxyAgent } from 'https-proxy-agent';
import type { ClientRequest } from 'node:http';
import { WebSourceError } from './web-safety.ts';

/** Server-only opt-in. Never change the global dispatcher or system proxy. */
export function webProxyUrl() {
  const value = process.env.WEB_HTTP_PROXY?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error();
    return url.href;
  } catch { throw new WebSourceError('WEB_HTTP_PROXY 配置无效：请使用不含账号密码的 HTTP/HTTPS 代理地址。', 503); }
}

let cached: { url: string; agent: ProxyAgent } | undefined;
export function webApiFetch(url: string, init: RequestInit) {
  // Only fixed service origins may use this helper with API credentials.
  if (!['https://api.tavily.com', 'https://api.deepseek.com'].includes(new URL(url).origin)) throw new WebSourceError('不允许代理未授权的 API 地址。');
  const proxy = webProxyUrl();
  if (!proxy) return fetch(url, init);
  if (cached?.url !== proxy) {
    if (cached) void cached.agent.close();
    cached = { url: proxy, agent: new ProxyAgent(proxy) };
  }
  return fetch(url, { ...init, dispatcher: cached.agent } as RequestInit);
}

/** CONNECT uses the validated IP, while HTTP Host and TLS SNI retain the origin. */
export class PinnedWebProxyAgent extends HttpsProxyAgent<string> {
  private address: string;
  private hostname: string;
  constructor(proxy: string, address: string, hostname: string, signal: AbortSignal) {
    super(proxy, { signal });
    this.address = address;
    this.hostname = hostname;
  }
  override connect(req: ClientRequest, opts: Parameters<HttpsProxyAgent<string>['connect']>[1]) {
    return super.connect(req, opts.secureEndpoint
      ? { ...opts, host: this.address, servername: this.hostname }
      : { ...opts, host: this.address });
  }
}
