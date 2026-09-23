import type {
  DocumentNodeDraft,
  DocumentNodeType,
  ExtractedPage,
} from "./types";

type PageRange = { page: number; start: number; end: number };
type Line = { text: string; start: number; end: number };
type Block = {
  type: DocumentNodeType;
  headingLevel: number | null;
  text: string;
  start: number;
  end: number;
  metadata: Record<string, unknown>;
};

export type StructuredDocument = {
  text: string;
  normalizedMarkdown: string;
  nodes: DocumentNodeDraft[];
};

export function normalizeDocumentText(value: string) {
  return value
    .replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\f\v]+/g, " ")
    .replace(/[ ]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function composePages(pages: ExtractedPage[]) {
  let cursor = 0;
  const ranges: PageRange[] = [];
  const parts = pages.map((page) => {
    const lines = normalizeDocumentText(page.text).split("\n");
    const isPageNumber = (value: string) => /^(?:第\s*)?\d{1,5}(?:\s*页)?$/.test(value.trim());
    if (lines.length > 1 && isPageNumber(lines[0])) lines.shift();
    if (lines.length > 1 && isPageNumber(lines.at(-1) || "")) lines.pop();
    return lines.join("\n").trim();
  });
  parts.forEach((part, index) => {
    ranges.push({ page: pages[index].page, start: cursor, end: cursor + part.length });
    cursor += part.length + (index === parts.length - 1 ? 0 : 2);
  });
  return { text: parts.join("\n\n").trim(), ranges };
}

function pageForOffset(ranges: PageRange[], offset: number) {
  return ranges.find((range) => offset >= range.start && offset <= range.end)?.page ?? null;
}

function linesWithOffsets(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (let index = 0; index <= text.length; index += 1) {
    if (index === text.length || text[index] === "\n") {
      lines.push({ text: text.slice(start, index), start, end: index });
      start = index + 1;
    }
  }
  return lines;
}

function markdownHeading(line: string) {
  const match = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
  if (!match) return null;
  return { level: match[1].length, title: match[2].trim() };
}

function inferredHeading(line: string) {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.length > 80) return null;
  const chapter = trimmed.match(/^第[一二三四五六七八九十百千万0-9]+([篇章部分节])[：:、.\s-]*(.*)$/);
  if (chapter) {
    const level = chapter[1] === "节" ? 2 : chapter[1] === "部分" ? 2 : 1;
    return { level, title: trimmed };
  }
  const decimal = trimmed.match(/^(\d+(?:\.\d+)+)[、.\s-]+(.+)$/);
  if (decimal) return { level: Math.min(6, decimal[1].split(".").length), title: trimmed };
  const chinese = trimmed.match(/^([一二三四五六七八九十]+)[、.]\s*(.+)$/);
  if (chinese && trimmed.length <= 36) return { level: 2, title: trimmed };
  const labeled = trimmed.match(/^(?:实验|示例|案例|练习|任务)\s*\d+(?:[-.]\d+)*(?:\s*[★☆]+)?\s*[：:]\s*\S.+$/);
  if (labeled) return { level: 3, title: trimmed };
  return null;
}

function footnoteLine(line: string) {
  return /^(?:[a-zA-Z]|[*†‡])\s*(?:感谢|注[：:]?)/.test(line.trim());
}

function normalizeProseText(value: string) {
  const lines = value.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length <= 1) return lines[0] || "";
  return lines.slice(1).reduce((joined, line) => {
    const previous = joined.at(-1) || "";
    const next = line[0] || "";
    const needsSpace = /[A-Za-z0-9)\]}]$/.test(previous) && /^[A-Za-z0-9([{]/.test(next);
    return `${joined}${needsSpace ? " " : ""}${line}`;
  }, lines[0]);
}

function listLine(line: string) {
  return /^\s*(?:[-*+]\s+|\d+[.)、]\s+|[（(]?[一二三四五六七八九十]+[）)、.]\s*)/.test(line);
}

function tableLine(line: string) {
  return (line.match(/\|/g)?.length || 0) >= 2;
}

function trimRange(text: string, start: number, end: number) {
  const slice = text.slice(start, end);
  const leading = slice.length - slice.trimStart().length;
  const trailing = slice.length - slice.trimEnd().length;
  return {
    text: text.slice(start + leading, Math.max(start + leading, end - trailing)),
    start: start + leading,
    end: Math.max(start + leading, end - trailing),
  };
}

function parseBlocks(text: string) {
  const lines = linesWithOffsets(text);
  const blocks: Block[] = [];
  let index = 0;

  const addBlock = (
    type: DocumentNodeType,
    start: number,
    end: number,
    headingLevel: number | null = null,
    metadata: Record<string, unknown> = {},
  ) => {
    const range = trimRange(text, start, end);
    if (!range.text) return;
    const blockText = type === "paragraph" || type === "caption"
      ? normalizeProseText(range.text)
      : range.text;
    blocks.push({ type, headingLevel, text: blockText, start: range.start, end: range.end, metadata });
  };

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.text.trim();
    if (!trimmed) {
      index += 1;
      continue;
    }

    const fence = trimmed.match(/^(```+|~~~+)/);
    if (fence) {
      const start = line.start;
      const marker = fence[1][0];
      const language = trimmed.slice(fence[1].length).trim();
      index += 1;
      while (index < lines.length && !new RegExp(`^\\s*${marker}{3,}`).test(lines[index].text)) index += 1;
      if (index < lines.length) index += 1;
      const end = lines[Math.max(0, index - 1)]?.end ?? text.length;
      addBlock("code", start, end, null, { language });
      continue;
    }

    if (trimmed.startsWith("$$")) {
      const start = line.start;
      index += 1;
      while (index < lines.length && !lines[index].text.trim().endsWith("$$")) index += 1;
      if (index < lines.length) index += 1;
      addBlock("equation", start, lines[Math.max(0, index - 1)]?.end ?? text.length);
      continue;
    }

    const explicitHeading = markdownHeading(line.text);
    const heuristicHeading = explicitHeading ? null : inferredHeading(line.text);
    const heading = explicitHeading || heuristicHeading;
    if (heading) {
      addBlock(blocks.length === 0 && heading.level === 1 ? "title" : "heading", line.start, line.end, heading.level, {
        inferred: !explicitHeading,
        displayText: heading.title,
      });
      index += 1;
      continue;
    }

    if (footnoteLine(line.text)) {
      const start = line.start;
      index += 1;
      while (index < lines.length) {
        const next = lines[index].text;
        if (!next.trim() || markdownHeading(next) || inferredHeading(next)) break;
        index += 1;
      }
      addBlock("caption", start, lines[index - 1].end, null, { inferred: true, role: "footnote" });
      continue;
    }

    if (tableLine(line.text) && index + 1 < lines.length && tableLine(lines[index + 1].text)) {
      const start = line.start;
      index += 2;
      while (index < lines.length && lines[index].text.trim() && tableLine(lines[index].text)) index += 1;
      addBlock("table", start, lines[index - 1].end);
      continue;
    }

    if (listLine(line.text)) {
      const start = line.start;
      index += 1;
      while (index < lines.length) {
        const next = lines[index].text;
        if (!next.trim()) break;
        if (markdownHeading(next) || inferredHeading(next)) break;
        if (!listLine(next) && !/^\s{2,}\S/.test(next)) break;
        index += 1;
      }
      addBlock("list", start, lines[index - 1].end);
      continue;
    }

    const start = line.start;
    index += 1;
    while (index < lines.length) {
      const next = lines[index].text;
      if (!next.trim()) break;
      if (markdownHeading(next) || inferredHeading(next) || listLine(next)) break;
      if (footnoteLine(next)) break;
      if (tableLine(next) && index + 1 < lines.length && tableLine(lines[index + 1].text)) break;
      if (/^\s*(```+|~~~+|\$\$)/.test(next)) break;
      index += 1;
    }
    addBlock("paragraph", start, lines[index - 1].end);
  }
  return blocks;
}

function headingDisplayText(block: Block) {
  const fromMetadata = block.metadata.displayText;
  if (typeof fromMetadata === "string" && fromMetadata.trim()) return fromMetadata.trim();
  return block.text.replace(/^\s{0,3}#{1,6}\s+/, "").replace(/\s*#+\s*$/, "").trim();
}

export function parseStructuredDocument(rawText: string, pages: ExtractedPage[] = []): StructuredDocument {
  const composed = pages.length > 0
    ? composePages(pages)
    : { text: normalizeDocumentText(rawText), ranges: [] as PageRange[] };
  const blocks = parseBlocks(composed.text);
  const nodes: DocumentNodeDraft[] = [];
  const headingStack: Array<{ level: number; title: string; position: number }> = [];

  for (const block of blocks) {
    if (block.type === "heading" || block.type === "title") {
      const level = block.headingLevel || 1;
      while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level) headingStack.pop();
      const parentPosition = headingStack.at(-1)?.position ?? null;
      const title = headingDisplayText(block);
      const sectionPath = [...headingStack.map((item) => item.title), title];
      const position = nodes.length;
      nodes.push({
        position,
        parentPosition,
        type: block.type,
        headingLevel: level,
        text: block.text,
        sectionPath,
        pageStart: pageForOffset(composed.ranges, block.start),
        pageEnd: pageForOffset(composed.ranges, Math.max(block.start, block.end - 1)),
        charStart: block.start,
        charEnd: block.end,
        metadata: block.metadata,
      });
      headingStack.push({ level, title, position });
      continue;
    }

    nodes.push({
      position: nodes.length,
      parentPosition: headingStack.at(-1)?.position ?? null,
      type: block.type,
      headingLevel: null,
      text: block.text,
      sectionPath: headingStack.map((item) => item.title),
      pageStart: pageForOffset(composed.ranges, block.start),
      pageEnd: pageForOffset(composed.ranges, Math.max(block.start, block.end - 1)),
      charStart: block.start,
      charEnd: block.end,
      metadata: block.metadata,
    });
  }

  return { text: composed.text, normalizedMarkdown: composed.text, nodes };
}

type HtmlNode = { tag: string; attributes: string; children: Array<HtmlNode | string> };

function decodeHtml(value: string) {
  const named: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  };
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (entity, name: string) => {
    if (name.startsWith("#")) {
      const hex = name[1]?.toLowerCase() === "x";
      const code = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : entity;
    }
    return named[name.toLowerCase()] ?? entity;
  });
}

function parseHtml(html: string) {
  const root: HtmlNode = { tag: "root", attributes: "", children: [] };
  const stack = [root];
  const voidTags = new Set(["br", "img", "hr", "meta", "link", "input"]);
  for (const token of html.match(/<!--[\s\S]*?-->|<[^>]+>|[^<]+/g) || []) {
    if (token.startsWith("<!--") || /^<!doctype/i.test(token)) continue;
    if (token.startsWith("</")) {
      const tag = token.match(/^<\/\s*([\w-]+)/)?.[1]?.toLowerCase();
      if (!tag) continue;
      while (stack.length > 1) {
        const closed = stack.pop();
        if (closed?.tag === tag) break;
      }
      continue;
    }
    if (token.startsWith("<")) {
      const match = token.match(/^<\s*([\w-]+)([\s\S]*?)\/?\s*>$/);
      if (!match) continue;
      const node: HtmlNode = { tag: match[1].toLowerCase(), attributes: match[2], children: [] };
      stack[stack.length - 1].children.push(node);
      if (!voidTags.has(node.tag) && !/\/>$/.test(token)) stack.push(node);
      continue;
    }
    stack[stack.length - 1].children.push(decodeHtml(token));
  }
  return root;
}

function htmlText(node: HtmlNode | string): string {
  if (typeof node === "string") return node;
  if (node.tag === "br") return "\n";
  return node.children.map(htmlText).join("");
}

function descendants(node: HtmlNode, tag: string): HtmlNode[] {
  const found: HtmlNode[] = [];
  for (const child of node.children) {
    if (typeof child === "string") continue;
    if (child.tag === tag) found.push(child);
    found.push(...descendants(child, tag));
  }
  return found;
}

function escapeTableCell(value: string) {
  return value.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();
}

function htmlBlockToMarkdown(node: HtmlNode): string[] {
  if (/^h[1-6]$/.test(node.tag)) {
    const level = Number(node.tag.slice(1));
    return [`${"#".repeat(level)} ${htmlText(node).trim()}`];
  }
  if (node.tag === "p") {
    const text = htmlText(node).replace(/\u00a0/g, " ").trim();
    return text ? [text] : [];
  }
  if (node.tag === "pre") {
    const text = htmlText(node).replace(/^\n|\n$/g, "");
    return text ? [`\`\`\`\n${text}\n\`\`\``] : [];
  }
  if (node.tag === "ul" || node.tag === "ol") {
    const items = node.children.filter((child): child is HtmlNode => typeof child !== "string" && child.tag === "li");
    const lines = items.map((item, index) => `${node.tag === "ol" ? `${index + 1}.` : "-"} ${htmlText(item).trim()}`);
    return lines.length > 0 ? [lines.join("\n")] : [];
  }
  if (node.tag === "table") {
    const rows = descendants(node, "tr").map((row) => {
      const cells = row.children.filter((child): child is HtmlNode =>
        typeof child !== "string" && (child.tag === "td" || child.tag === "th"));
      return cells.map((cell) => escapeTableCell(htmlText(cell)));
    }).filter((row) => row.length > 0);
    if (rows.length === 0) return [];
    const width = Math.max(...rows.map((row) => row.length));
    const padded = rows.map((row) => [...row, ...Array(Math.max(0, width - row.length)).fill("")]);
    return [[
      `| ${padded[0].join(" | ")} |`,
      `| ${Array(width).fill("---").join(" | ")} |`,
      ...padded.slice(1).map((row) => `| ${row.join(" | ")} |`),
    ].join("\n")];
  }
  if (node.tag === "img") {
    const alt = node.attributes.match(/\balt\s*=\s*["']([^"']*)["']/i)?.[1]?.trim();
    return alt ? [`[图片：${decodeHtml(alt)}]`] : [];
  }
  return node.children.flatMap((child) => typeof child === "string" ? [] : htmlBlockToMarkdown(child));
}

/** Convert Mammoth's constrained HTML output into the canonical Markdown layer. */
export function mammothHtmlToMarkdown(html: string) {
  const root = parseHtml(html);
  return normalizeDocumentText(root.children.flatMap((child) =>
    typeof child === "string" ? [] : htmlBlockToMarkdown(child)).join("\n\n"));
}
