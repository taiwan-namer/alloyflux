import { buyerGoogleConfigured, getSessionUser, homePathFor, publicUser } from "@/lib/auth";
import { balance, quotaCapFromLedger, usageSummary } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = await getSessionUser(req);
  if (!user) {
    return Response.json({
      user: null,
      googleEnabled: buyerGoogleConfigured(),
    });
  }
  return Response.json(
    {
      user: publicUser(user),
      balance: await balance(user.id),
      quotaCap: await quotaCapFromLedger(user.id),
      usage: await usageSummary(user.id),
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
