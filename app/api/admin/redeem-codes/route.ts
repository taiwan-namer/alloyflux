import { jsonError } from "@/lib/auth";
import { cloudDbProxy } from "@/lib/cloud-api";
import { createRedeemCode, listRecentRedeemCodes } from "@/lib/redeem";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const proxied = await cloudDbProxy(req);
  if (proxied) return proxied;
  try {
    return Response.json({ codes: await listRecentRedeemCodes(30) });
  } catch (e) {
    return jsonError(e);
  }
}

export async function POST(req: Request) {
  const proxied = await cloudDbProxy(req);
  if (proxied) return proxied;
  try {
    const body = (await req.json().catch(() => ({}))) as {
      points?: number;
      maxUses?: number;
      note?: string;
    };
    const created = await createRedeemCode({
      points: body.points ?? 1000,
      maxUses: body.maxUses ?? 1,
      note: body.note ?? "admin mint",
    });
    return Response.json({ ok: true, ...created });
  } catch (e) {
    return jsonError(e);
  }
}
