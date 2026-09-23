import { isIP } from "node:net";

export class WebSourceError extends Error {
  status: number;
  constructor(message: string, status = 422) { super(message); this.status = status; }
}

/** Syntax validation; direct fetching also validates and pins DNS results. */
export function publicWebUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new WebSourceError("网页地址无效。"); }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port
    || isIP(host) || host.includes(":") || !host.includes(".")
    || /(^|\.)(localhost|local|internal|lan|home|test|invalid)$/.test(host)) {
    throw new WebSourceError("仅支持公开网页域名，不能使用本机、IP 地址或内网地址。");
  }
  url.hostname = host;
  url.hash = "";
  return url.href;
}
