import { parseStructuredDocument } from "./structure.ts";
import type {
  DocumentNodeDraft,
  DocumentNodeType,
  ExtractedDocument,
  ExtractedPage,
  SourceChunkDraft,
  SourceChunkSetDraft,
} from "./types";

export const SOURCE_CHUNKER_VERSION = "structure-parent-child-v2";

const DEFAULT_MIN_CHILD_TOKENS = 220;
const DEFAULT_TARGET_CHILD_TOKENS = 450;
const DEFAULT_MAX_CHILD_TOKENS = 700;
const DEFAULT_MAX_PARENT_TOKENS = 2_400;

type ChunkConfig = {
  minChildTokens: number;
  targetChildTokens: number;
  maxChildTokens: number;
  maxParentTokens: number;
};

type AtomicUnit = {
  type: DocumentNodeType;
  text: string;
  sectionPath: string[];
  pageStart: number | null;
  pageEnd: number | null;
  charStart: number;
  charEnd: number;
  tokenEstimate: number;
  nodeStartPosition: number;
  nodeEndPosition: number;
  boundaryMethod: "node" | "recursive";
};

type ChildCandidate = Omit<SourceChunkDraft, "position" | "parentPosition">;

export function estimateTokens(content: string) {
  const cjk = content.match(/[\u3400-\u9fff\uf900-\ufaff]/g)?.length || 0;
  const words = content.match(/[A-Za-z0-9_]+/g)?.length || 0;
  const other = Math.max(0, content.length - cjk - words);
  return Math.max(1, Math.ceil(cjk + words * 1.3 + other / 4));
}

function nullableMin(values: Array<number | null>) {
  const present = values.filter((value): value is number => value !== null);
  return present.length > 0 ? Math.min(...present) : null;
}

function nullableMax(values: Array<number | null>) {
  const present = values.filter((value): value is number => value !== null);
  return present.length > 0 ? Math.max(...present) : null;
}

function cleanHeading(value: string) {
  return value.replace(/^\s{0,3}#{1,6}\s+/, "").replace(/\s*#+\s*$/, "").trim();
}

function chooseRecursiveBoundary(text: string, start: number, desiredEnd: number, type: DocumentNodeType) {
  if (desiredEnd >= text.length) return text.length;
  const minimum = start + Math.max(1, Math.floor((desiredEnd - start) * 0.55));
  const region = text.slice(minimum, desiredEnd);
  const separators = type === "code" || type === "table" || type === "list"
    ? ["\n"]
    : ["\n\n", "。”", "！”", "？”", "。", "！", "？", ". ", "! ", "? ", "；", "; ", "\n", "，", ", ", " "];
  for (const separator of separators) {
    const index = region.lastIndexOf(separator);
    if (index >= 0) return minimum + index + separator.length;
  }
  return desiredEnd;
}

function splitOversizedNode(node: DocumentNodeDraft, maxTokens: number): AtomicUnit[] {
  const tokenEstimate = estimateTokens(node.text);
  const specialLimit = node.type === "code" || node.type === "table" ? Math.floor(maxTokens * 1.5) : maxTokens;
  if (tokenEstimate <= specialLimit) {
    return [{
      type: node.type,
      text: node.text,
      sectionPath: node.sectionPath,
      pageStart: node.pageStart,
      pageEnd: node.pageEnd,
      charStart: node.charStart,
      charEnd: node.charEnd,
      tokenEstimate,
      nodeStartPosition: node.position,
      nodeEndPosition: node.position,
      boundaryMethod: "node",
    }];
  }

  const charsPerToken = Math.max(0.5, node.text.length / tokenEstimate);
  const targetChars = Math.max(160, Math.floor(charsPerToken * maxTokens));
  const units: AtomicUnit[] = [];
  let start = 0;
  while (start < node.text.length) {
    const boundary = chooseRecursiveBoundary(node.text, start, Math.min(node.text.length, start + targetChars), node.type);
    const slice = node.text.slice(start, boundary);
    const leading = slice.length - slice.trimStart().length;
    const trailing = slice.length - slice.trimEnd().length;
    const localStart = start + leading;
    const localEnd = Math.max(localStart, boundary - trailing);
    const content = node.text.slice(localStart, localEnd);
    if (content) {
      units.push({
        type: node.type,
        text: content,
        sectionPath: node.sectionPath,
        pageStart: node.pageStart,
        pageEnd: node.pageEnd,
        charStart: node.charStart + localStart,
        charEnd: node.charStart + localEnd,
        tokenEstimate: estimateTokens(content),
        nodeStartPosition: node.position,
        nodeEndPosition: node.position,
        boundaryMethod: "recursive",
      });
    }
    if (boundary >= node.text.length) break;
    start = Math.max(start + 1, boundary);
  }
  return units;
}

function collectAtomicUnits(document: ExtractedDocument, config: ChunkConfig) {
  const contentNodes = document.nodes.filter((node) => node.type !== "heading" && node.type !== "title");
  const sourceNodes = contentNodes.length > 0
    ? contentNodes
    : document.nodes.map((node) => ({ ...node, type: "paragraph" as const, text: cleanHeading(node.text) }));
  return sourceNodes.flatMap((node) => splitOversizedNode(node, config.maxChildTokens));
}

function sectionKey(path: string[]) {
  return JSON.stringify(path);
}

function mergeAtomicUnits(units: AtomicUnit[]): ChildCandidate {
  const sectionPath = units[0]?.sectionPath || [];
  const contextPrefix = sectionPath.join(" > ");
  const content = units.map((unit) => unit.text).join("\n\n");
  const methods = [...new Set(units.map((unit) => unit.boundaryMethod))];
  const unitTypes = [...new Set(units.map((unit) => unit.type))];
  return {
    heading: sectionPath.at(-1) || "",
    sectionPath,
    contextPrefix,
    content,
    pageStart: nullableMin(units.map((unit) => unit.pageStart)),
    pageEnd: nullableMax(units.map((unit) => unit.pageEnd)),
    charStart: Math.min(...units.map((unit) => unit.charStart)),
    charEnd: Math.max(...units.map((unit) => unit.charEnd)),
    tokenEstimate: estimateTokens(content),
    nodeStartPosition: Math.min(...units.map((unit) => unit.nodeStartPosition)),
    nodeEndPosition: Math.max(...units.map((unit) => unit.nodeEndPosition)),
    boundaryReason: {
      method: methods.includes("recursive") ? "structure+recursive" : "structure",
      unitTypes,
      unitCount: units.length,
      overlap: false,
    },
  };
}

function buildChildCandidates(units: AtomicUnit[], config: ChunkConfig) {
  const candidates: ChildCandidate[] = [];
  let current: AtomicUnit[] = [];
  let currentTokens = 0;

  const flush = () => {
    if (current.length > 0) candidates.push(mergeAtomicUnits(current));
    current = [];
    currentTokens = 0;
  };

  for (const unit of units) {
    const isIsolated = unit.type === "code" || unit.type === "table" || unit.type === "equation";
    const differentSection = current.length > 0 && sectionKey(current[0].sectionPath) !== sectionKey(unit.sectionPath);
    if (differentSection || (isIsolated && current.length > 0)) flush();

    if (isIsolated) {
      current = [unit];
      currentTokens = unit.tokenEstimate;
      flush();
      continue;
    }

    const combined = currentTokens + unit.tokenEstimate;
    const fitsTarget = combined <= config.targetChildTokens;
    const fillsSmallChunk = currentTokens < config.minChildTokens && combined <= config.maxChildTokens;
    if (current.length === 0 || fitsTarget || fillsSmallChunk) {
      current.push(unit);
      currentTokens = combined;
    } else {
      flush();
      current.push(unit);
      currentTokens = unit.tokenEstimate;
    }
  }
  flush();

  if (candidates.length >= 2) {
    const last = candidates[candidates.length - 1];
    const previous = candidates[candidates.length - 2];
    const lastTypes = last.boundaryReason.unitTypes as string[] | undefined;
    const previousTypes = previous.boundaryReason.unitTypes as string[] | undefined;
    if (
      last.tokenEstimate < config.minChildTokens
      && sectionKey(last.sectionPath) === sectionKey(previous.sectionPath)
      && last.tokenEstimate + previous.tokenEstimate <= config.maxChildTokens
      && !["table", "code", "equation"].some((type) => lastTypes?.includes(type) || previousTypes?.includes(type))
    ) {
      candidates.splice(candidates.length - 2, 2, mergeAtomicUnits([
        {
          type: "paragraph",
          text: previous.content,
          sectionPath: previous.sectionPath,
          pageStart: previous.pageStart,
          pageEnd: previous.pageEnd,
          charStart: previous.charStart,
          charEnd: previous.charEnd,
          tokenEstimate: previous.tokenEstimate,
          nodeStartPosition: previous.nodeStartPosition ?? 0,
          nodeEndPosition: previous.nodeEndPosition ?? 0,
          boundaryMethod: previous.boundaryReason.method === "structure+recursive" ? "recursive" : "node",
        },
        {
          type: "paragraph",
          text: last.content,
          sectionPath: last.sectionPath,
          pageStart: last.pageStart,
          pageEnd: last.pageEnd,
          charStart: last.charStart,
          charEnd: last.charEnd,
          tokenEstimate: last.tokenEstimate,
          nodeStartPosition: last.nodeStartPosition ?? 0,
          nodeEndPosition: last.nodeEndPosition ?? 0,
          boundaryMethod: last.boundaryReason.method === "structure+recursive" ? "recursive" : "node",
        },
      ]));
    }
  }
  return candidates;
}

function createParent(position: number, children: ChildCandidate[]) {
  const sectionPath = children[0]?.sectionPath || [];
  const contextPrefix = sectionPath.join(" > ");
  const body = children.map((child) => child.content).join("\n\n");
  const content = contextPrefix ? `${contextPrefix}\n\n${body}` : body;
  return {
    position,
    heading: sectionPath.at(-1) || "",
    sectionPath,
    content,
    pageStart: nullableMin(children.map((child) => child.pageStart)),
    pageEnd: nullableMax(children.map((child) => child.pageEnd)),
    charStart: Math.min(...children.map((child) => child.charStart)),
    charEnd: Math.max(...children.map((child) => child.charEnd)),
    tokenEstimate: estimateTokens(content),
  };
}

export function buildChunkSet(
  document: ExtractedDocument,
  options: Partial<ChunkConfig> = {},
): SourceChunkSetDraft {
  const config: ChunkConfig = {
    minChildTokens: Math.max(50, options.minChildTokens || DEFAULT_MIN_CHILD_TOKENS),
    targetChildTokens: Math.max(100, options.targetChildTokens || DEFAULT_TARGET_CHILD_TOKENS),
    maxChildTokens: Math.max(200, options.maxChildTokens || DEFAULT_MAX_CHILD_TOKENS),
    maxParentTokens: Math.max(500, options.maxParentTokens || DEFAULT_MAX_PARENT_TOKENS),
  };
  if (config.targetChildTokens > config.maxChildTokens) config.targetChildTokens = config.maxChildTokens;
  if (config.minChildTokens > config.targetChildTokens) config.minChildTokens = config.targetChildTokens;

  const units = collectAtomicUnits(document, config);
  const candidates = buildChildCandidates(units, config);
  const parents: SourceChunkSetDraft["parents"] = [];
  const chunks: SourceChunkDraft[] = [];
  let parentChildren: ChildCandidate[] = [];
  let parentTokens = 0;

  const flushParent = () => {
    if (parentChildren.length === 0) return;
    const parentPosition = parents.length;
    parents.push(createParent(parentPosition, parentChildren));
    for (const child of parentChildren) {
      chunks.push({ ...child, position: chunks.length, parentPosition });
    }
    parentChildren = [];
    parentTokens = 0;
  };

  for (const candidate of candidates) {
    const differentSection = parentChildren.length > 0
      && sectionKey(parentChildren[0].sectionPath) !== sectionKey(candidate.sectionPath);
    const exceedsParent = parentChildren.length > 0
      && parentTokens + candidate.tokenEstimate > config.maxParentTokens;
    if (differentSection || exceedsParent) flushParent();
    parentChildren.push(candidate);
    parentTokens += candidate.tokenEstimate;
  }
  flushParent();

  return {
    strategy: "structure-recursive-parent-child",
    strategyVersion: SOURCE_CHUNKER_VERSION,
    config: {
      ...config,
      overlap: false,
      retrievalUnit: "child",
      contextUnit: "parent",
    },
    warnings: [],
    parents,
    chunks,
  };
}

/** Backward-compatible helper for tests and one-off scripts. */
export function chunkDocument(rawText: string, pages: ExtractedPage[] = []) {
  const structured = parseStructuredDocument(rawText, pages);
  const document: ExtractedDocument = {
    status: "ready",
    text: structured.text,
    normalizedMarkdown: structured.normalizedMarkdown,
    pages,
    nodes: structured.nodes,
    parserName: "direct-text",
    parserVersion: "direct-text-v1",
    outputFormat: "markdown+nodes",
    warnings: [],
    errorMessage: "",
  };
  return buildChunkSet(document).chunks;
}
