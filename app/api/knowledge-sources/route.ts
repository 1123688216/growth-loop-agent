import { getCurrentUser } from "@/lib/auth/session";
import {
  createKnowledgeSource,
  KnowledgeSourceConflictError,
  KnowledgeSourceChunkingError,
  listKnowledgeSources,
} from "@/lib/db/knowledge-sources";
import {
  detectSourceKind,
  SourceValidationError,
} from "@/lib/knowledge/extract";
import {
  ingestKnowledgeSource,
  KnowledgeIngestionError,
} from "@/lib/knowledge/ingestion";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(error: unknown) {
  if (error instanceof KnowledgeSourceConflictError) {
    return Response.json({ error: error.message }, { status: 409 });
  }
  if (error instanceof KnowledgeSourceChunkingError) {
    return Response.json({ error: error.message }, { status: 422 });
  }
  if (error instanceof SourceValidationError) {
    const status = error.code === "TOO_LARGE" ? 413 : error.code === "UNSUPPORTED" ? 415 : 422;
    return Response.json({ error: error.message }, { status });
  }
  if (error instanceof KnowledgeIngestionError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  console.error("knowledge source upload failed", error);
  return Response.json({ error: "资料处理失败，请稍后重试。" }, { status: 500 });
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "未登录。" }, { status: 401 });
  return Response.json(
    { sources: listKnowledgeSources(user.id) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "未登录。" }, { status: 401 });

  try {
    const contentType = request.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const body = await request.json() as { title?: unknown; description?: unknown; text?: unknown };
      const title = typeof body.title === "string" ? body.title.trim() : "";
      const description = typeof body.description === "string" ? body.description.trim() : "";
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!title) throw new SourceValidationError("请填写资料名称。", "INVALID");
      if (!text) throw new SourceValidationError("请粘贴资料内容。", "EMPTY");
      const buffer = Buffer.from(text, "utf8");
      const ingestion = await ingestKnowledgeSource({
        buffer,
        kind: "text",
        filename: "pasted-text.md",
        mimeType: "text/markdown; charset=utf-8",
      });
      return Response.json({ source: createKnowledgeSource({
        userId: user.id,
        title,
        description,
        kind: "text",
        originalFilename: "",
        mimeType: "text/plain; charset=utf-8",
        buffer,
        extracted: ingestion.extracted,
        chunkSet: ingestion.chunkSet,
      }) }, { status: 201 });
    }

    if (!contentType.includes("multipart/form-data")) {
      return Response.json({ error: "请上传文件或提交文本。" }, { status: 415 });
    }
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new SourceValidationError("请选择要上传的文件。", "INVALID");
    const kind = detectSourceKind(file.name, file.type);
    const buffer = Buffer.from(await file.arrayBuffer());
    const titleField = form.get("title");
    const title = typeof titleField === "string" ? titleField.trim() : "";
    const descriptionField = form.get("description");
    const description = typeof descriptionField === "string" ? descriptionField.trim() : "";
    const ingestion = await ingestKnowledgeSource({
      buffer,
      kind,
      filename: file.name,
      mimeType: file.type,
    });
    return Response.json({ source: createKnowledgeSource({
      userId: user.id,
      title: title || file.name.replace(/\.[^.]+$/, ""),
      description,
      kind,
      originalFilename: file.name.slice(0, 255),
      mimeType: file.type.slice(0, 120),
      buffer,
      extracted: ingestion.extracted,
      chunkSet: ingestion.chunkSet,
    }) }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
