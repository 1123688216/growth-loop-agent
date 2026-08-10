import { createHash } from "node:crypto";

export type WechatInboundMessage = {
  toUserName?: string;
  fromUserName?: string;
  msgType?: string;
  content?: string;
  msgId?: string;
  createTime?: string;
  encrypt?: string;
};

function decodeXml(value: string) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function readTag(xml: string, tag: string) {
  const cdata = xml.match(new RegExp(`<${tag}>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`));
  if (cdata?.[1]) return decodeXml(cdata[1].trim());

  const plain = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return plain?.[1] ? decodeXml(plain[1].trim()) : undefined;
}

export function parseWechatXml(xml: string): WechatInboundMessage {
  return {
    toUserName: readTag(xml, "ToUserName"),
    fromUserName: readTag(xml, "FromUserName"),
    msgType: readTag(xml, "MsgType")?.toLowerCase(),
    content: readTag(xml, "Content"),
    msgId: readTag(xml, "MsgId"),
    createTime: readTag(xml, "CreateTime"),
    encrypt: readTag(xml, "Encrypt"),
  };
}

export function isWechatSignatureValid(
  token: string | undefined,
  timestamp: string | null,
  nonce: string | null,
  signature: string | null,
) {
  if (!token || !timestamp || !nonce || !signature) return false;

  const expected = createHash("sha1")
    .update([token, timestamp, nonce].sort().join(""))
    .digest("hex");
  return expected === signature;
}

function cdata(value: string) {
  return `<![CDATA[${value.replaceAll("]]>", "]]]]><![CDATA[>")}]]>`;
}

export function xmlTextReply(toUserName: string, fromUserName: string, content: string) {
  const time = Math.floor(Date.now() / 1000);
  return [
    "<xml>",
    `<ToUserName>${cdata(toUserName)}</ToUserName>`,
    `<FromUserName>${cdata(fromUserName)}</FromUserName>`,
    `<CreateTime>${time}</CreateTime>`,
    `<MsgType>${cdata("text")}</MsgType>`,
    `<Content>${cdata(content)}</Content>`,
    "</xml>",
  ].join("");
}
