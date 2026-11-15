import { jsonError, requireUser } from "@/lib/auth";
import { listConversations } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    return Response.json(await listConversations(user.id));
  } catch (e) {
    return jsonError(e);
  }
}
