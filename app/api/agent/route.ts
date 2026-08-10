import { NextResponse } from "next/server";
import { getAgentStatus, runAgent } from "@/lib/agent/provider";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(getAgentStatus(), {
    headers: { "Cache-Control": "no-store" },
  });
}

function errorResponse(error: string, status = 400) {
  return NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("invalid JSON body");
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return errorResponse("request body must be an object");
  }

  const input = body as Record<string, unknown>;
  if (typeof input.message !== "string") {
    return errorResponse("message must be a string");
  }

  const message = input.message.trim();
  if (!message) {
    return errorResponse("message is required");
  }

  if (input.output !== undefined && typeof input.output !== "string") {
    return errorResponse("output must be a string");
  }

  if (input.context !== undefined && typeof input.context !== "string") {
    return errorResponse("context must be a string");
  }

  const headerSession = request.headers.get("x-agent-session")?.trim();
  const conversationId = typeof input.conversationId === "string" ? input.conversationId.trim() : headerSession;

  try {
    const result = await runAgent(message, {
      conversationId,
      output: typeof input.output === "string" ? input.output.trim() : undefined,
      context: typeof input.context === "string" ? input.context.trim() : undefined,
    });
    return NextResponse.json({ ...result, conversationId: conversationId || "anonymous" }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return errorResponse("agent unavailable", 500);
  }
}
