import { getSessionUser, jsonError } from "@/lib/auth";
import { getOrCreateGuestIdentity } from "@/lib/free-tier";
import { listConversations } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const user = await getSessionUser(req);
    if (user) {
      return Response.json(await listConversations(user.id));
    }
    const guest = getOrCreateGuestIdentity(req);
    const headers = new Headers();
    if (guest.setCookieHeader) headers.append("Set-Cookie", guest.setCookieHeader);
    return Response.json(await listConversations(guest.guestUserId), { headers });
  } catch (e) {
    return jsonError(e);
  }
}
