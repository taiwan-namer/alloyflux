import { getSessionUser, jsonError } from "@/lib/auth";
import { cloudDbProxy } from "@/lib/cloud-api";
import { getOrCreateGuestIdentity } from "@/lib/free-tier";
import { deleteConversation, getConversation, listMessages } from "@/lib/store";

export const dynamic = "force-dynamic";

async function resolveActorId(req: Request): Promise<string> {
  const user = await getSessionUser(req);
  if (user) return user.id;
  return getOrCreateGuestIdentity(req).guestUserId;
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const proxied = await cloudDbProxy(req);
  if (proxied) return proxied;
  try {
    const actorId = await resolveActorId(req);
    const { id } = await ctx.params;
    const conversation = await getConversation(actorId, id);
    if (!conversation) return Response.json({ error: "找不到對話" }, { status: 404 });
    return Response.json({ conversation, messages: await listMessages(id) });
  } catch (e) {
    return jsonError(e);
  }
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const proxied = await cloudDbProxy(req);
  if (proxied) return proxied;
  try {
    const actorId = await resolveActorId(req);
    const { id } = await ctx.params;
    await deleteConversation(actorId, id);
    return Response.json({ ok: true });
  } catch (e) {
    return jsonError(e);
  }
}
