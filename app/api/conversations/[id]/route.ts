import { getSessionUser, jsonError } from "@/lib/auth";
import { cloudDbProxy } from "@/lib/cloud-api";
import { getOrCreateGuestIdentity } from "@/lib/free-tier";
import { deleteConversation, getConversation, listMessagesPage } from "@/lib/store";

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

    const url = new URL(req.url);
    const limitRaw = Number(url.searchParams.get("limit") ?? "5");
    const beforeCreatedAtRaw = url.searchParams.get("beforeCreatedAt");
    const beforeId = url.searchParams.get("beforeId") ?? undefined;
    const beforeCreatedAt =
      beforeCreatedAtRaw != null && beforeCreatedAtRaw !== ""
        ? Number(beforeCreatedAtRaw)
        : undefined;

    const page = await listMessagesPage(id, {
      limit: Number.isFinite(limitRaw) ? limitRaw : 5,
      beforeCreatedAt:
        typeof beforeCreatedAt === "number" && Number.isFinite(beforeCreatedAt)
          ? beforeCreatedAt
          : undefined,
      beforeId,
    });

    return Response.json({
      conversation,
      messages: page.messages,
      hasMore: page.hasMore,
    });
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
