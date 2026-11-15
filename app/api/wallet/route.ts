import { jsonError, requireUser } from "@/lib/auth";
import { cloudDbProxy } from "@/lib/cloud-api";
import { getFreeDailyStatus } from "@/lib/free-tier";
import { testTopUpKey, testTopUpPoints } from "@/lib/redeem";
import { balance, quotaCapFromLedger, topUp, usageSummary } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const proxied = await cloudDbProxy(req);
  if (proxied) return proxied;
  try {
    const user = await requireUser(req);
    let bal = await balance(user.id);

    // 封測：設了 TEST_AUTO_TOPUP=1 且有 TEST_TOPUP_KEY 時，餘額過低自動補點
    const auto = process.env.TEST_AUTO_TOPUP?.trim() === "1";
    if (auto && testTopUpKey() && bal < 100) {
      const pts = testTopUpPoints();
      await topUp(user.id, pts, "封測自動儲值（餘額不足）");
      bal = await balance(user.id);
    }

    return Response.json(
      {
        balance: bal,
        quotaCap: await quotaCapFromLedger(user.id),
        usage: await usageSummary(user.id),
        hasPaidAccess: user.isAdmin || bal > 0,
        freeQuota: await getFreeDailyStatus({ userId: user.id, isGuest: false }),
        apiKey: user.apiKey,
        testTopUpEnabled: Boolean(testTopUpKey()),
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

/**
 * 封測儲值：POST { key: TEST_TOPUP_KEY, points?: number }
 * 未設定 TEST_TOPUP_KEY 時回 410（正式環境請勿設定）。
 */
export async function POST(req: Request) {
  const proxied = await cloudDbProxy(req);
  if (proxied) return proxied;
  try {
    const expected = testTopUpKey();
    if (!expected) {
      return Response.json({ error: "測試儲值已關閉，請使用兌換碼入帳" }, { status: 410 });
    }
    const user = await requireUser(req);
    const body = (await req.json().catch(() => ({}))) as { key?: string; points?: number };
    if (!body.key || body.key.trim().toUpperCase() !== expected.toUpperCase()) {
      return Response.json({ error: "儲值金鑰不正確" }, { status: 403 });
    }
    const pts =
      typeof body.points === "number" && Number.isFinite(body.points) && body.points > 0
        ? Math.min(Math.floor(body.points), 100_000)
        : testTopUpPoints();
    await topUp(user.id, pts, "封測金鑰儲值");
    const bal = await balance(user.id);
    return Response.json({
      ok: true,
      points: pts,
      balance: bal,
      quotaCap: await quotaCapFromLedger(user.id),
      hasPaidAccess: true,
      message: `已儲值 ${pts} 額度`,
    });
  } catch (e) {
    return jsonError(e);
  }
}
