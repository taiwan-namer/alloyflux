import { buyerGoogleConfigured, getSessionUser, homePathFor, publicUser } from "@/lib/auth";
import { getFreeDailyStatus, getOrCreateGuestIdentity } from "@/lib/free-tier";
import { balance, quotaCapFromLedger, usageSummary } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = await getSessionUser(req);
  if (!user) {
    const guest = getOrCreateGuestIdentity(req);
    const freeQuota = await getFreeDailyStatus({
      userId: guest.guestUserId,
      isGuest: true,
      ipBucketId: guest.ipBucketId,
    });
    const headers = new Headers({
      "Cache-Control": "no-store, no-cache, must-revalidate",
      Pragma: "no-cache",
    });
    if (guest.setCookieHeader) headers.append("Set-Cookie", guest.setCookieHeader);
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

  const bal = await balance(user.id);
  const hasPaidAccess = user.isAdmin || bal > 0;
  const freeQuota = await getFreeDailyStatus({
    userId: user.id,
    isGuest: false,
  });

  return Response.json(
    {
      user: publicUser(user),
      balance: bal,
      quotaCap: await quotaCapFromLedger(user.id),
      usage: await usageSummary(user.id),
      hasPaidAccess,
      freeQuota,
      googleEnabled: buyerGoogleConfigured(),
      redirect: homePathFor(user),
    },
    {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate",
        Pragma: "no-cache",
      },
    },
  );
}
