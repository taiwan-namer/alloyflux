import { getSessionUser, jsonError } from "@/lib/auth";
import { cloudDbProxy } from "@/lib/cloud-api";
import { getOrCreateGuestIdentity } from "@/lib/free-tier";
import {
  deleteConversation,
  getConversation,
  listMessagesPage,
  renameConversation,
  restoreConversation,
  softDeleteConversation,
} from "@/lib/store";

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

/** PATCH：重新命名 { title } 或還原 { restore: true } */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const proxied = await cloudDbProxy(req);
  if (proxied) return proxied;
  try {
    const actorId = await resolveActorId(req);
    const { id } = await ctx.params;
    const body = (await req.json()) as { title?: string; restore?: boolean };

    if (body.restore === true) {
      const ok = await restoreConversation(actorId, id);
      if (!ok) return Response.json({ error: "找不到可還原的對話" }, { status: 404 });
      return Response.json({ ok: true });
    }

    if (typeof body.title === "string") {
      const ok = await renameConversation(actorId, id, body.title);
      if (!ok) return Response.json({ error: "重新命名失敗" }, { status: 400 });
      return Response.json({ ok: true, title: body.title.trim().slice(0, 80) });
    }

    return Response.json({ error: "請提供 title 或 restore" }, { status: 400 });
  } catch (e) {
    return jsonError(e);
  }
}

/** DELETE：預設軟刪除至垃圾桶；?permanent=1 永久刪除 */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const proxied = await cloudDbProxy(req);
  if (proxied) return proxied;
  try {
    const actorId = await resolveActorId(req);
    const { id } = await ctx.params;
    const permanent = new URL(req.url).searchParams.get("permanent") === "1";

    if (permanent) {
      await deleteConversation(actorId, id);
      return Response.json({ ok: true, permanent: true });
    }

    const ok = await softDeleteConversation(actorId, id);
    if (!ok) return Response.json({ error: "找不到對話" }, { status: 404 });
    return Response.json({ ok: true, trashed: true });
  } catch (e) {
    return jsonError(e);
  }
}
