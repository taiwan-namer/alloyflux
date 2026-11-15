import { jsonError, requireUser } from "@/lib/auth";
import { getFreeDailyStatus } from "@/lib/free-tier";
import { balance, quotaCapFromLedger, usageSummary } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    const bal = await balance(user.id);
    return Response.json(
      {
        balance: bal,
        quotaCap: await quotaCapFromLedger(user.id),
        usage: await usageSummary(user.id),
        hasPaidAccess: user.isAdmin || bal > 0,
        freeQuota: await getFreeDailyStatus({ userId: user.id, isGuest: false }),
        apiKey: user.apiKey,
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

/** 已停用公開測試儲值；請用兌換碼 POST /api/wallet/redeem */
export async function POST() {
  return Response.json(
    { error: "測試儲值已關閉，請使用兌換碼入帳" },
    { status: 410 },
  );
}
