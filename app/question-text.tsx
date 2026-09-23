import { Fragment } from 'react';

/** Small, escaped text renderer; never interprets generated HTML. */
export default function QuestionText({text}: {text:string}) {
  const parts=text.replace(/\r\n?/g,'\n').split(/(```[^\n]*\n[\s\S]*?(?:\n```|$))/g);
  return <div className="question-text">{parts.map((part,index)=>{
    if(!part)return null;
    if(part.startsWith('```')) {
      const newline=part.indexOf('\n');
      return <pre tabIndex={0} aria-label="题目代码，可横向滚动" key={index}><code>{part.slice(newline+1).replace(/\n```$/,'')}</code></pre>;
    }
    return <Fragment key={index}>{part.split(/\n\s*\n/).filter(p=>p.trim()).map((paragraph,i)=>
      /^\s*\{\s*role\s*:/.test(paragraph)
        ? <pre tabIndex={0} aria-label="题目轨迹，可横向滚动" key={i}><code>{paragraph}</code></pre>
        : <p key={i}>{paragraph.split(/(`[^`\n]+`)/g).map((piece,j)=>piece.startsWith('`')&&piece.endsWith('`')?<code key={j}>{piece.slice(1,-1)}</code>:piece)}</p>
    )}</Fragment>;
  })}</div>;
}
