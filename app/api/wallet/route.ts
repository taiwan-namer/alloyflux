import { jsonError, requireUser } from "@/lib/auth";
import { balance, quotaCapFromLedger, usageSummary } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const user = requireUser(req);
    return Response.json(
      {
        balance: balance(user.id),
        quotaCap: quotaCapFromLedger(user.id),
        usage: usageSummary(user.id),
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
