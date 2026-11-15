import { jsonError, requireUser } from "@/lib/auth";
import { redeemCode } from "@/lib/redeem";
import { balance, quotaCapFromLedger } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const user = requireUser(req);
    const body = (await req.json()) as { code?: string };
    const result = redeemCode(user.id, body.code || "");
    return Response.json(
      {
        ok: true,
        points: result.points,
        message: result.balanceNote,
        balance: balance(user.id),
        quotaCap: quotaCapFromLedger(user.id),
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
