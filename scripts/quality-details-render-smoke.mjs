import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const source = readFileSync(new URL('../app/lesson-quality-details.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } }).outputText;
const exports = {};
// Execute the actual local TSX component, rather than checking strings in its source.
new Function('require', 'exports', compiled)(createRequire(import.meta.url), exports);
const render = (lesson) => renderToStaticMarkup(React.createElement(exports.default, { lesson }));
const report = { deterministicPassed: false, semanticPassed: false, score: 40, checkedAt: '2026-09-07T12:00:00Z', issues: [
  { code: 'thin_block', severity: 'error', message: '例子缺少推导步骤', blockIds: ['b1'], repairInstruction: '补充逐步推导' },
  { code: 'warning', severity: 'warning', message: '课时偏长', blockIds: [], repairInstruction: '拆分内容' },
] };
const html = render({ generationStatus: 'failed', qualityReport: report, blocks: [{ id: 'b1', title: '事务示例' }] });
for (const text of ['open=""', '1 项需修复', '1 项建议', '例子缺少推导步骤', '事务示例', '补充逐步推导']) assert(html.includes(text), text);
assert(render({ generationStatus: 'failed' }).includes('没有可读取'));
assert(!render({ generationStatus: 'ready', qualityReport: { ...report, issues: [] } }).includes('open=""'));
const pending = render({generationStatus:'failed',qualityReport:{...report,issues:[{code:'semantic_review_unavailable',severity:'error',message:'审核服务不可用',blockIds:[]}]}});
assert(pending.includes('等待复核'));assert(pending.includes('不是内容不合格'));assert(!pending.includes('1 项需修复'));
const demo=render({generationStatus:'ready',qualityReport:{...report,semanticPassed:true,issues:[{code:'demo_semantic_review',severity:'warning',message:'demo',blockIds:[]}]}});
assert(demo.includes('演示模式，未执行模型复核'));assert(!demo.includes('语义检查：通过'));
const parent = readFileSync(new URL('../app/learning-studio.tsx', import.meta.url), 'utf8');
assert(parent.includes('import LessonQualityDetails from "./lesson-quality-details"'));
console.log('PASS: actual React rendering of failed, passed and missing-report states; explicit classroom import.');
