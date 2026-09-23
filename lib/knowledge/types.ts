export type KnowledgeSourceKind = "text" | "txt" | "pdf" | "docx";
export type KnowledgeSourceStatus = "processing" | "ready" | "ocr_required" | "failed" | "deleted";
export type GoalSourceScopeMode = "auto" | "selected";
export type GoalSourceLinkStatus = "active" | "disabled";
export type DocumentNodeType =
  | "title"
  | "heading"
  | "paragraph"
  | "list"
  | "code"
  | "table"
  | "equation"
  | "image"
  | "caption";

export type ExtractedPage = {
  page: number;
  text: string;
};

export type DocumentNodeDraft = {
  position: number;
  parentPosition: number | null;
  type: DocumentNodeType;
  headingLevel: number | null;
  text: string;
  sectionPath: string[];
  pageStart: number | null;
  pageEnd: number | null;
  charStart: number;
  charEnd: number;
  metadata: Record<string, unknown>;
};

export type ExtractedDocument = {
  status: Extract<KnowledgeSourceStatus, "ready" | "ocr_required" | "failed">;
  text: string;
  normalizedMarkdown: string;
  pages: ExtractedPage[];
  nodes: DocumentNodeDraft[];
  parserName: string;
  parserVersion: string;
  outputFormat: string;
  warnings: string[];
  errorMessage: string;
};

export type SourceParentChunkDraft = {
  position: number;
  heading: string;
  sectionPath: string[];
  content: string;
  pageStart: number | null;
  pageEnd: number | null;
  charStart: number;
  charEnd: number;
  tokenEstimate: number;
};

export type SourceChunkDraft = {
  position: number;
  parentPosition: number;
  heading: string;
  sectionPath: string[];
  contextPrefix: string;
  content: string;
  pageStart: number | null;
  pageEnd: number | null;
  charStart: number;
  charEnd: number;
  tokenEstimate: number;
  nodeStartPosition: number | null;
  nodeEndPosition: number | null;
  boundaryReason: Record<string, unknown>;
};

export type SourceChunkSetDraft = {
  strategy: string;
  strategyVersion: string;
  config: Record<string, unknown>;
  warnings: string[];
  parents: SourceParentChunkDraft[];
  chunks: SourceChunkDraft[];
};

export type KnowledgeSourceSummary = {
  id: string;
  title: string;
  description: string;
  kind: KnowledgeSourceKind;
  originalFilename: string;
  mimeType: string;
  byteSize: number;
  status: Exclude<KnowledgeSourceStatus, "deleted">;
  chunkCount: number;
  parentChunkCount: number;
  chunkStrategy: string;
  chunkStrategyVersion: string;
  charCount: number;
  warningMessage: string;
  errorMessage: string;
  createdAt: string;
  updatedAt: string;
};

export type KnowledgeSourceChunk = {
  id: string;
  position: number;
  parentId: string;
  parentPosition: number;
  parentHeading: string;
  parentContent: string;
  parentTokenEstimate: number;
  heading: string;
  sectionPath: string[];
  contextPrefix: string;
  content: string;
  pageStart: number | null;
  pageEnd: number | null;
  charStart: number;
  charEnd: number;
  tokenEstimate: number;
  nodeStartPosition: number | null;
  nodeEndPosition: number | null;
  boundaryReason: Record<string, unknown>;
};

export type KnowledgeSourceChunkSet = {
  id: string;
  strategy: string;
  strategyVersion: string;
  parentCount: number;
  childCount: number;
  createdAt: string;
};

export type KnowledgeSourceChunkPage = {
  source: KnowledgeSourceSummary;
  chunkSet: KnowledgeSourceChunkSet | null;
  chunks: KnowledgeSourceChunk[];
  total: number;
  offset: number;
  limit: number;
  query: string;
};

export type GoalSourceOption = {
  source: KnowledgeSourceSummary;
  linkStatus: GoalSourceLinkStatus | null;
  included: boolean;
  inclusionReason: "automatic" | "selected" | "excluded" | "not_selected";
};

export type GoalSourceScope = {
  goalId: string;
  mode: GoalSourceScopeMode;
  sources: GoalSourceOption[];
  includedSourceIds: string[];
  excludedSourceIds: string[];
};
