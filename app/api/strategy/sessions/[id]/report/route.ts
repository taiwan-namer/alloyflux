import { cloudDbProxy } from "@/lib/cloud-api";
import { authenticatePlatformApiKey } from "@/lib/platform-api-auth";
import { addSessionReport, getStrategySession, STRATEGY_LIMITS } from "@/lib/strategy-loop";

export const dynamic = "force-dynamic";

/**
 * Cursor 本機彙總後的分析報告（不是原始 K 線／fills）。
 * Body: { title, content, kind?, requestId? }
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const proxied = await cloudDbProxy(req);
  if (proxied) return proxied;
  const auth = await authenticatePlatformApiKey(req);
  if (!auth) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id: sessionId } = await ctx.params;
  const session = await getStrategySession(auth.user.id, sessionId);
  if (!session) return Response.json({ error: "Not found" }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as {
    title?: string;
    content?: string;
    kind?: string;
    requestId?: string;
  };
  const content = (body.content || "").trim();
  if (!content) return Response.json({ error: "content required" }, { status: 400 });
  if (content.length > STRATEGY_LIMITS.reportMaxChars) {
    return Response.json(
      {
        error: `報告 ${content.length} 字，超過上限 ${STRATEGY_LIMITS.reportMaxChars} 字；請在本機再彙總（表格、統計、分組），不要上傳原始資料`,
        limits: STRATEGY_LIMITS,
      },
      { status: 413 },
    );
  }

  const created = await addSessionReport({
    sessionId,
    userId: auth.user.id,
    title: body.title || "report",
    content,
    kind: body.kind,
    requestId: body.requestId,
  });
  return Response.json({ report: created, limits: STRATEGY_LIMITS });
}
