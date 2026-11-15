import { jsonError, requireUser } from "@/lib/auth";
import { cloudDbProxy } from "@/lib/cloud-api";
import { getFreeDailyStatus } from "@/lib/free-tier";
import { redeemCode } from "@/lib/redeem";
import { balance, quotaCapFromLedger } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const proxied = await cloudDbProxy(req);
  if (proxied) return proxied;
  try {
    const user = await requireUser(req);
    const body = (await req.json()) as { code?: string };
    const result = await redeemCode(user.id, body.code || "");
    const bal = await balance(user.id);
    return Response.json(
      {
        ok: true,
        points: result.points,
        message: result.balanceNote,
        balance: bal,
        quotaCap: await quotaCapFromLedger(user.id),
        hasPaidAccess: user.isAdmin || bal > 0,
        freeQuota: await getFreeDailyStatus({ userId: user.id, isGuest: false }),
      },
      {
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate",
          Pragma: "no-cache",
        },
      },
    );
  } catch (e) {
    return jsonError(e);
  }
}
