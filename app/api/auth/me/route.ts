import { buyerGoogleConfigured, getSessionUser, homePathFor, publicUser } from "@/lib/auth";
import { freeDailyMessageLimit, getFreeDailyStatus, getOrCreateGuestIdentity, taipeiDayStartMs } from "@/lib/free-tier";
import { balance, quotaCapFromLedger, usageSummary } from "@/lib/store";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

function defaultFreeQuota() {
  const limit = freeDailyMessageLimit();
  const since = taipeiDayStartMs();
  return { used: 0, limit, remaining: limit, resetAtMs: since + 86_400_000 };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), ms);
      }),
    ]);
  } catch {
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function GET(req: Request) {
  const headers = new Headers({
    "Cache-Control": "no-store, no-cache, must-revalidate",
    Pragma: "no-cache",
  });

  try {
    const user = await withTimeout(getSessionUser(req), 5_000, null);
    if (!user) {
      const guest = getOrCreateGuestIdentity(req);
      if (guest.setCookieHeader) headers.append("Set-Cookie", guest.setCookieHeader);
      const freeQuota = await withTimeout(
        getFreeDailyStatus({
          userId: guest.guestUserId,
          isGuest: true,
          ipBucketId: guest.ipBucketId,
        }),
        4_000,
        defaultFreeQuota(),
      );
      return Response.json(
        {
          user: null,
          hasPaidAccess: false,
          freeQuota,
          googleEnabled: buyerGoogleConfigured(),
        },
        { headers },
      );
    }

    const bal = await withTimeout(balance(user.id), 4_000, 0);
    const hasPaidAccess = user.isAdmin || bal > 0;
    const [freeQuota, quotaCap, usage] = await Promise.all([
      withTimeout(
        getFreeDailyStatus({ userId: user.id, isGuest: false }),
        4_000,
        defaultFreeQuota(),
      ),
      withTimeout(quotaCapFromLedger(user.id), 4_000, Math.max(1000, bal)),
      withTimeout(usageSummary(user.id), 4_000, { messages: 0, chargedPoints: 0, officialPoints: 0 }),
    ]);

    return Response.json(
      {
        user: publicUser(user),
        balance: bal,
        quotaCap,
        usage,
        hasPaidAccess,
        freeQuota,
        googleEnabled: buyerGoogleConfigured(),
        redirect: homePathFor(user),
      },
      { headers },
    );
  } catch {
    // 絕對不要讓首頁永遠卡在「載入中」
    const guest = getOrCreateGuestIdentity(req);
    if (guest.setCookieHeader) headers.append("Set-Cookie", guest.setCookieHeader);
    return Response.json(
      {
        user: null,
        hasPaidAccess: false,
        freeQuota: defaultFreeQuota(),
        googleEnabled: buyerGoogleConfigured(),
        degraded: true,
      },
      { headers, status: 200 },
    );
  }
}
