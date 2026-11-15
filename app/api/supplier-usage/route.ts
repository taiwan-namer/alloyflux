import { jsonError, requireSupplier } from "@/lib/auth";
import { listSources } from "@/lib/sources";
import { supplierUsage } from "@/lib/store";

export const dynamic = "force-dynamic";

const WEEK_MS = 7 * 24 * 3600_000;

export async function GET(req: Request) {
  try {
    requireSupplier(req);
    const since = Date.now() - WEEK_MS;
    return Response.json(
      listSources()
        .filter((s) => s.authType === "oauth_sub")
        .map((s) => ({
          sourceId: s.id,
          label: s.label,
          provider: s.provider,
          quota: s.quota,
          ...supplierUsage(s.id, since),
        })),
    );
  } catch (e) {
    return jsonError(e);
  }
}
