import path from "node:path";
import mammoth from "mammoth";
import { mammothHtmlToMarkdown, parseStructuredDocument } from "./structure.ts";
import type { ExtractedDocument, KnowledgeSourceKind } from "./types";

export const SOURCE_PARSER_VERSION = "source-parser-v3";
const DOCX_MAX_FILES = 2_000;
const DOCX_SUSPICIOUS_RATIO = 1_000;
const DOCX_RATIO_MIN_BYTES = 20 * 1024 * 1024;

const MIME_KIND: Record<string, KnowledgeSourceKind> = {
  "text/plain": "txt",
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
};

export class SourceValidationError extends Error {
  readonly code: "INVALID" | "TOO_LARGE" | "UNSUPPORTED" | "EMPTY";

  constructor(message: string, code: "INVALID" | "TOO_LARGE" | "UNSUPPORTED" | "EMPTY") {
    super(message);
    this.code = code;
  }
}

export function detectSourceKind(filename: string, mimeType: string): KnowledgeSourceKind {
  const extension = path.extname(filename).toLowerCase();
  if (extension === ".txt") return "txt";
  if (extension === ".pdf") return "pdf";
  if (extension === ".docx") return "docx";
  const byMime = MIME_KIND[mimeType.toLowerCase()];
  if (byMime) return byMime;
  throw new SourceValidationError("暂时只支持 TXT、PDF 和 DOCX 文件。旧版 .doc 请先另存为 .docx。", "UNSUPPORTED");
}

function assertNotEmpty(buffer: Buffer) {
  if (buffer.length === 0) throw new SourceValidationError("文件内容为空。", "EMPTY");
}

function decodeText(buffer: Buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    try {
      return new TextDecoder("gb18030", { fatal: true }).decode(buffer);
    } catch {
      throw new SourceValidationError("TXT 编码无法识别，请保存为 UTF-8 或 GB18030 后重试。", "INVALID");
    }
  }
}

function validateDocxArchive(buffer: Buffer) {
  if (buffer.length < 4 || buffer.readUInt16LE(0) !== 0x4b50) {
    throw new SourceValidationError("文件扩展名是 DOCX，但内容不是有效的 ZIP/Office 文档。", "INVALID");
  }
  let files = 0;
  let totalCompressed = 0;
  let totalUncompressed = 0;
  let hasContentTypes = false;
  let hasDocumentXml = false;
  for (let offset = 0; offset + 46 <= buffer.length;) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      offset += 1;
      continue;
    }
    const compressed = buffer.readUInt32LE(offset + 20);
    const uncompressed = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const recordLength = 46 + nameLength + extraLength + commentLength;
    if (uncompressed === 0xffffffff || offset + recordLength > buffer.length) {
      throw new SourceValidationError("暂不支持 ZIP64 或目录损坏的 DOCX 文件。", "INVALID");
    }
    const filename = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8").replace(/\\/g, "/");
    files += 1;
    totalCompressed += compressed;
    totalUncompressed += uncompressed;
    hasContentTypes ||= filename === "[Content_Types].xml";
    hasDocumentXml ||= filename === "word/document.xml";
    const suspiciousEntry = uncompressed >= DOCX_RATIO_MIN_BYTES && uncompressed > Math.max(1, compressed) * DOCX_SUSPICIOUS_RATIO;
    const suspiciousArchive = totalUncompressed >= DOCX_RATIO_MIN_BYTES && totalUncompressed > Math.max(1, totalCompressed) * DOCX_SUSPICIOUS_RATIO;
    if (files > DOCX_MAX_FILES || suspiciousEntry || suspiciousArchive) {
      throw new SourceValidationError("DOCX 压缩结构异常或文件条目过多，无法安全解析。", "INVALID");
    }
    offset += recordLength;
  }
  if (files === 0 || !hasContentTypes || !hasDocumentXml) {
    throw new SourceValidationError("DOCX 缺少必要的 Office 文档结构。", "INVALID");
  }
}

function failed(error: unknown): ExtractedDocument {
  return {
    status: "failed",
    text: "",
    normalizedMarkdown: "",
    pages: [],
    nodes: [],
    parserName: "unknown",
    parserVersion: SOURCE_PARSER_VERSION,
    outputFormat: "markdown+nodes",
    warnings: [],
    errorMessage: error instanceof Error ? error.message : "资料解析失败。",
  };
}

function readyDocument(input: {
  rawText: string;
  pages?: ExtractedDocument["pages"];
  parserName: string;
  warnings?: string[];
}) {
  const pages = input.pages || [];
  const structured = parseStructuredDocument(input.rawText, pages);
  return {
    status: "ready" as const,
    text: structured.text,
    normalizedMarkdown: structured.normalizedMarkdown,
    pages,
    nodes: structured.nodes,
    parserName: input.parserName,
    parserVersion: SOURCE_PARSER_VERSION,
    outputFormat: "markdown+nodes",
    warnings: input.warnings || [],
    errorMessage: "",
  };
}

export async function extractSource(buffer: Buffer, kind: KnowledgeSourceKind): Promise<ExtractedDocument> {
  assertNotEmpty(buffer);
  try {
    if (kind === "text" || kind === "txt") {
      const text = decodeText(buffer).replace(/\u0000/g, "").trim();
      if (!text) return failed(new Error("资料中没有可读取的文字。"));
      return readyDocument({ rawText: text, parserName: kind === "text" ? "pasted-markdown" : "text-markdown" });
    }

    if (kind === "docx") {
      validateDocxArchive(buffer);
      const result = await mammoth.convertToHtml({ buffer }, {
        styleMap: [
          "p[style-name='Code'] => pre:fresh",
          "p[style-name='代码'] => pre:fresh",
        ],
        convertImage: mammoth.images.imgElement(async () => ({ src: "" })),
      });
      const markdown = mammothHtmlToMarkdown(result.value);
      const warnings = result.messages.map((message) => message.message).filter(Boolean).slice(0, 20);
      if (result.value.includes("<img")) warnings.push("Word 中的图片暂未进入文本切片，后续由多模态解析器处理。");
      if (!markdown) return failed(new Error("Word 文档中没有可读取的文字。"));
      return readyDocument({ rawText: markdown, parserName: "mammoth-html", warnings });
    }

    if (buffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
      throw new SourceValidationError("文件扩展名是 PDF，但文件头不符合 PDF 格式。", "INVALID");
    }
    await import("pdf-parse/worker");
    const { PDFParse } = await import("pdf-parse");
    const data = new Uint8Array(buffer);
    const parser = new PDFParse({ data });
    try {
      const result = await parser.getText();
      const pages = result.pages.map((page) => ({ page: page.num, text: page.text.trim() }));
      const structured = parseStructuredDocument("", pages);
      const text = structured.text;
      if (text.length < 30) {
        return {
          status: "ocr_required",
          text,
          normalizedMarkdown: structured.normalizedMarkdown,
          pages,
          nodes: structured.nodes,
          parserName: "pdf-parse",
          parserVersion: SOURCE_PARSER_VERSION,
          outputFormat: "markdown+nodes",
          warnings: ["PDF 可能是扫描件，目前版本未启用 OCR。"],
          errorMessage: "没有提取到足够的可检索文字。",
        };
      }
      return {
        status: "ready",
        text,
        normalizedMarkdown: structured.normalizedMarkdown,
        pages,
        nodes: structured.nodes,
        parserName: "pdf-parse",
        parserVersion: SOURCE_PARSER_VERSION,
        outputFormat: "markdown+nodes",
        warnings: ["当前 PDF 使用本地文本解析；接入 MinerU 后可进一步保留版面、表格和图片结构。"],
        errorMessage: "",
      };
    } finally {
      await parser.destroy();
    }
  } catch (error) {
    if (error instanceof SourceValidationError) throw error;
    return failed(error);
  }
}
