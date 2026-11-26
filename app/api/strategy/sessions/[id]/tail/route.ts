import { cloudDbProxy } from "@/lib/cloud-api";
import { authenticateStrategyReader } from "@/lib/platform-api-auth";
import { readLiveHostTail } from "@/lib/strategy-loop";

export const dynamic = "force-dynamic";

/** 最新一則主持人回覆。畫面用這條跟上 Cursor 回合，不重拉整包同步。 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const proxied = await cloudDbProxy(req);
  if (proxied) return proxied;
  const auth = await authenticateStrategyReader(req);
  if (!auth) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const tail = await readLiveHostTail(auth.user.id, id);
  return Response.json({ tail });
}
