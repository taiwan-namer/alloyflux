import { syncAllSubscriptionQuotas } from "@/lib/sources";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (secret) {
    const auth = req.headers.get("authorization") ?? "";
    if (auth === `Bearer ${secret}`) return true;
  }
  // Vercel Cron 內建標頭（未設 CRON_SECRET 時仍可跑）
  if (req.headers.get("x-vercel-cron") === "1") return true;
  return false;
}

/** 背景自動同步四大訂閱池用量（Vercel Cron） */
export async function GET(req: Request) {
  if (!authorized(req)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    await syncAllSubscriptionQuotas();
    return Response.json({ ok: true, syncedAt: Date.now() });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ error: msg }, { status: 500 });
  }
}
