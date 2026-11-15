import { buyerGoogleConfigured, getSessionUser, homePathFor, publicUser } from "@/lib/auth";
import { balance, quotaCapFromLedger, usageSummary } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = getSessionUser(req);
  if (!user) {
    return Response.json({
      user: null,
      googleEnabled: buyerGoogleConfigured(),
    });
  }
  return Response.json(
    {
      user: publicUser(user),
      balance: balance(user.id),
      quotaCap: quotaCapFromLedger(user.id),
      usage: usageSummary(user.id),
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
