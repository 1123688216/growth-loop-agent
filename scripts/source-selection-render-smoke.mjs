import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const nativeRequire=createRequire(import.meta.url);
function component(file) {
  const exports={};
  const code=ts.transpileModule(readFileSync(new URL('../app/'+file,import.meta.url),'utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS}}).outputText;
  new Function('require','exports',code)(name=>{
    if(name==='react-dom')return {createPortal:child=>child};
    if(name==='./web-source-search')return component('web-source-search.tsx');
    return nativeRequire(name);
  },exports);
  return exports;
}
globalThis.document={body:{}};
try {
  const Dialog=component('goal-source-scope.tsx').default;
  const html=renderToStaticMarkup(React.createElement(Dialog,{goalId:'test',goalTitle:'Java',initialOpen:true,onSaved:()=>{}}));
  for(const text of ['role="dialog"','课程正在等待','补充要求','搜索资料摘要','保存并继续课程','稍后选择'])assert(html.includes(text),text);
  assert(html.includes('class="goal-source-body"'));
  assert(html.includes('已有资料库'));
  assert(html.includes('class="goal-existing-sources"'));
  const css=readFileSync(new URL('../app/globals.css',import.meta.url),'utf8');
  assert.match(css,/\.goal-source-body \{[^}]*min-height: 0;[^}]*overflow-y: auto;/);
  assert.match(css,/\.goal-source-dialog \{[^}]*display: flex;[^}]*flex-direction: column;/);
  const closed=renderToStaticMarkup(React.createElement(Dialog,{goalId:'test',goalTitle:'Java'}));
  assert(!closed.includes('role="dialog"'));
  console.log('PASS: actual React initial waiting dialog renders search/refinement and explicit continue controls; normal entry stays closed.');
}finally{delete globalThis.document;}
