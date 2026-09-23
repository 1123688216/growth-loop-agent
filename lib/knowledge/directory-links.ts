import { publicWebUrl } from './web-safety.ts';

/** Cheap bounded ranking. Never follows a link merely because it is in a directory. */
export function rankDirectoryLinks(markdown:string, base:string, query:string, limit=3) {
  const origin = new URL(base).origin;
  const terms = [...new Set(query.toLowerCase().match(/[a-z0-9_-]{2,}|[\u4e00-\u9fff]{2,}/g) || [])];
  const found = new Map<string,{url:string;title:string;score:number}>();
  for (const match of markdown.slice(0,200000).matchAll(/\[([^\]\n]{1,180})\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
    try {
      const url = new URL(match[2],base); url.hash='';
      if(url.origin!==origin || url.href===base || /\.(pdf|zip|png|jpg|gif|exe)$/i.test(url.pathname)) continue;
      publicWebUrl(url.href);
      const haystack = (match[1]+' '+decodeURIComponent(url.pathname)).toLowerCase();
      const score = terms.reduce((n,t)=>n+(haystack.includes(t)?t.length:0),0);
      if(score>0) found.set(url.href,{url:url.href,title:match[1],score});
    } catch { /* Reject malformed and non-public URLs. Fetch layer validates DNS again. */ }
  }
  return [...found.values()].sort((a,b)=>b.score-a.score || a.url.localeCompare(b.url)).slice(0,Math.min(3,Math.max(0,limit)));
}
