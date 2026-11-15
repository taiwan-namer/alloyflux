import { jsonError, requireAdmin } from "@/lib/auth";
import { createRedeemCode, listRecentRedeemCodes } from "@/lib/redeem";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    requireAdmin(req);
    return Response.json({ codes: listRecentRedeemCodes(30) });
  } catch (e) {
    return jsonError(e);
  }
}

export async function POST(req: Request) {
  try {
    requireAdmin(req);
    const body = (await req.json().catch(() => ({}))) as {
      points?: number;
      maxUses?: number;
      note?: string;
    };
    const created = createRedeemCode({
      points: body.points ?? 1000,
      maxUses: body.maxUses ?? 1,
      note: body.note ?? "admin mint",
    });
    return Response.json({ ok: true, ...created });
  } catch (e) {
    return jsonError(e);
  }
}
