import { runAgent } from "@/lib/agent/provider";
import { isWechatSignatureValid, parseWechatXml, xmlTextReply } from "@/lib/wechat/adapter";

export const runtime = "nodejs";

function textResponse(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

function xmlResponse(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/xml; charset=utf-8",
    },
  });
}

function isValidRequest(request: Request) {
  const url = new URL(request.url);
  return isWechatSignatureValid(
    process.env.WECHAT_TOKEN,
    url.searchParams.get("timestamp"),
    url.searchParams.get("nonce"),
    url.searchParams.get("signature"),
  );
}

export async function GET(request: Request) {
  const token = process.env.WECHAT_TOKEN?.trim();
  if (!token) return textResponse("WECHAT_TOKEN is not configured", 503);
  if (!isValidRequest(request)) return textResponse("invalid signature", 401);

  const echostr = new URL(request.url).searchParams.get("echostr");
  return echostr ? textResponse(echostr) : textResponse("echostr is required", 400);
}

export async function POST(request: Request) {
  const token = process.env.WECHAT_TOKEN?.trim();
  if (!token) return textResponse("WECHAT_TOKEN is not configured", 503);
  if (!isValidRequest(request)) return textResponse("invalid signature", 401);

  try {
    const message = parseWechatXml(await request.text());
    if (message.encrypt) {
      return textResponse(
        "Encrypted WeChat messages are not enabled. Set the official account to plaintext mode for this MVP.",
        501,
      );
    }

    if (!message.fromUserName || !message.toUserName) {
      return textResponse("invalid WeChat message", 400);
    }

    if (message.msgType !== "text" || !message.content?.trim()) {
      return xmlResponse(
        xmlTextReply(message.fromUserName, message.toUserName, "目前先支持文字消息。直接告诉我你今天完成了什么，我会帮你记入成长记录。"),
      );
    }

    const result = await runAgent(message.content.trim(), { timeoutMs: 3_800 });
    const fallbackPrefix = result.mode === "demo" ? "（本地回退）" : "";
    return xmlResponse(xmlTextReply(message.fromUserName, message.toUserName, `${fallbackPrefix}${result.reply}`));
  } catch {
    return textResponse("wechat message unavailable", 500);
  }
}
