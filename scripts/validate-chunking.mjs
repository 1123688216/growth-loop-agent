import assert from "node:assert/strict";

import { buildChunkSet } from "../lib/knowledge/chunking.ts";
import { parseStructuredDocument } from "../lib/knowledge/structure.ts";

const longParagraph = Array.from({ length: 80 }, (_, index) =>
  `第${index + 1}个判断需要结合输入条件、边界情况和可复现的验证结果，不能只给出抽象结论。`).join("");
const markdown = `# RAG 设计

这是整体说明，用来验证标题路径和普通段落。

## 切片策略

- 结构分块保留标题
- 递归分块只处理过长原子节点
- 父子分块负责上下文扩展

| 方法 | 用途 |
| --- | --- |
| 结构 | 主策略 |
| 递归 | 兜底 |

\`\`\`ts
const strategy = "parent-child";
\`\`\`

## 超长说明

${longParagraph}`;

const structured = parseStructuredDocument(markdown);
const document = {
  status: "ready",
  text: structured.text,
  normalizedMarkdown: structured.normalizedMarkdown,
  pages: [],
  nodes: structured.nodes,
  parserName: "test",
  parserVersion: "test-v1",
  outputFormat: "markdown+nodes",
  warnings: [],
  errorMessage: "",
};
const result = buildChunkSet(document);

const pdfLikeText = `关键观察包括：工具的执行由服务端完成，而不是把搜索引擎装进模型。工具本身及其执行都在模
型之外的基础设施里完成。RL 优化的是决策策略，而不是工具执行机制。
实验 1-3 ★：Deep Research 能力
第二个实验展示先进模型如何把搜索、阅读和分析闭环起来。传统方式中，模型调用
工具时必须提供结构化参数。`;
const pdfLikeStructured = parseStructuredDocument(pdfLikeText);
const pdfLikeResult = buildChunkSet({
  ...document,
  text: pdfLikeStructured.text,
  normalizedMarkdown: pdfLikeStructured.normalizedMarkdown,
  nodes: pdfLikeStructured.nodes,
}, { minChildTokens: 50, targetChildTokens: 70, maxChildTokens: 100, maxParentTokens: 500 });

assert(structured.nodes.some((node) => node.type === "heading" || node.type === "title"));
assert(structured.nodes.some((node) => node.type === "list"), "list atom was not detected");
assert(structured.nodes.some((node) => node.type === "table"), "table atom was not detected");
assert(structured.nodes.some((node) => node.type === "code"), "code atom was not detected");
assert(result.parents.length >= 3, "heading sections did not produce parent chunks");
assert(result.chunks.length > result.parents.length, "long section did not produce child chunks");
assert(result.chunks.some((chunk) => chunk.boundaryReason.method === "structure+recursive"));
assert(pdfLikeStructured.nodes.some((node) => node.type === "heading" && node.text.startsWith("实验 1-3")), "experiment heading was not detected");
assert(pdfLikeStructured.nodes.some((node) => node.text.includes("模型之外") && !node.text.includes("模\n型")), "PDF soft line break was not repaired");
assert(!pdfLikeResult.chunks.some((chunk) => chunk.content.startsWith("型之外")), "child starts in the middle of a PDF-wrapped word");
assert(!pdfLikeResult.chunks.some((chunk) => chunk.content.endsWith("模型调用")), "child ends in the middle of a sentence");
for (const chunk of result.chunks) {
  const parent = result.parents[chunk.parentPosition];
  assert(parent, `missing parent for child ${chunk.position}`);
  assert(parent.content.includes(chunk.content), `parent ${parent.position} does not contain child ${chunk.position}`);
  assert(chunk.charEnd >= chunk.charStart);
}

console.log(JSON.stringify({
  nodeCount: structured.nodes.length,
  nodeTypes: [...new Set(structured.nodes.map((node) => node.type))],
  parentCount: result.parents.length,
  childCount: result.chunks.length,
  recursiveChildCount: result.chunks.filter((chunk) => chunk.boundaryReason.method === "structure+recursive").length,
  strategy: result.strategyVersion,
}));
