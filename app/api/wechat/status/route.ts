export const runtime = "nodejs";

export async function GET() {
  const appIdConfigured = Boolean(process.env.WECHAT_APP_ID?.trim());
  const tokenConfigured = Boolean(process.env.WECHAT_TOKEN?.trim());
  const aesKeyConfigured = Boolean(process.env.WECHAT_ENCODING_AES_KEY?.trim());

  return Response.json({
    configured: appIdConfigured && tokenConfigured,
    appIdConfigured,
    tokenConfigured,
    aesKeyConfigured,
    endpoint: "/api/wechat",
    mode: "plaintext-signature",
  });
}
