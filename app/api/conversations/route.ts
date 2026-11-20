import { getSessionUser, jsonError } from "@/lib/auth";
import { cloudDbProxy } from "@/lib/cloud-api";
import { getOrCreateGuestIdentity } from "@/lib/free-tier";
import {
  listConversations,
  listTrashedConversations,
  purgeTrashedConversations,
} from "@/lib/store";

export const dynamic = "force-dynamic";

async function resolveActorId(req: Request): Promise<{ actorId: string; setCookieHeader?: string }> {
  const user = await getSessionUser(req);
  if (user) return { actorId: user.id };
  const guest = getOrCreateGuestIdentity(req);
  return { actorId: guest.guestUserId, setCookieHeader: guest.setCookieHeader };
}

export async function GET(req: Request) {
  const proxied = await cloudDbProxy(req);
  if (proxied) return proxied;
  try {
    const { actorId, setCookieHeader } = await resolveActorId(req);
    const trash = new URL(req.url).searchParams.get("trash") === "1";
    const list = trash ? await listTrashedConversations(actorId) : await listConversations(actorId);
    const headers = new Headers();
    if (setCookieHeader) headers.append("Set-Cookie", setCookieHeader);
    return Response.json(list, { headers });
  } catch (e) {
    return jsonError(e);
  }
}

/** DELETE ?trash=1 → 清空垃圾桶（永久刪除） */
export async function DELETE(req: Request) {
  const proxied = await cloudDbProxy(req);
  if (proxied) return proxied;
  try {
    const { actorId } = await resolveActorId(req);
    if (new URL(req.url).searchParams.get("trash") !== "1") {
      return Response.json({ error: "請指定 trash=1 以清空垃圾桶" }, { status: 400 });
    }
    const purged = await purgeTrashedConversations(actorId);
    return Response.json({ ok: true, purged });
  } catch (e) {
    return jsonError(e);
  }
}
