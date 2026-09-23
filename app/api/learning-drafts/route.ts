import { getCurrentUser } from '@/lib/auth/session';
import { DraftError, readAnswerDraft, saveAnswerDraft } from '@/lib/db/answer-drafts';

export const runtime = 'nodejs';
function reply(data: unknown, status = 200) { return Response.json(data,{status,headers:{'Cache-Control':'no-store'}}); }
function id(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || value.length > 180) throw new DraftError('课程标识不正确。');
  return value;
}
function failure(error: unknown) {
  return error instanceof DraftError ? reply({error:error.message},error.status) : reply({error:'草稿服务暂时不可用，答案未确认保存，请稍后重试。'},503);
}
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return reply({error:'请登录后读取草稿。'},401);
  try {
    const params = new URL(request.url).searchParams;
    return reply(readAnswerDraft(user.id,id(params.get('programId')),id(params.get('lessonId'))));
  } catch(error) { return failure(error); }
}
export async function PUT(request: Request) {
  const user = await getCurrentUser();
  if (!user) return reply({error:'请登录后保存草稿。'},401);
  try {
    const bodyText = await request.text();
    if (new TextEncoder().encode(bodyText).length > 60000) throw new DraftError('草稿内容过长。',413);
    let body: Record<string,unknown>;
    try { body = JSON.parse(bodyText); } catch { throw new DraftError('草稿不是有效JSON。'); }
    if (!body || Array.isArray(body) || typeof body !== 'object') throw new DraftError('草稿格式不正确。');
    return reply(saveAnswerDraft(user.id,{programId:id(body.programId),lessonId:id(body.lessonId),fingerprint:id(body.fingerprint),revision:body.revision as number,answers:body.answers}));
  } catch(error) { return failure(error); }
}
