import { jsonError, requireSupplier } from "@/lib/auth";
import { cloudDbProxy } from "@/lib/cloud-api";
import { listSourcesForUser } from "@/lib/sources";
import { supplierUsage } from "@/lib/store";

export const dynamic = "force-dynamic";

const WEEK_MS = 7 * 24 * 3600_000;

export async function GET(req: Request) {
  const proxied = await cloudDbProxy(req);
  if (proxied) return proxied;
  try {
    const user = await requireSupplier(req);
    const since = Date.now() - WEEK_MS;
    // 含已軟刪節點：移除綁定後「近 7 天已累計分潤」不得歸零
    const sources = (await listSourcesForUser(user, { includeRemoved: true })).filter(
      (s) => s.authType === "oauth_sub",
    );
    return Response.json(
      await Promise.all(
        sources.map(async (s) => ({
          sourceId: s.id,
          label: s.removedAt ? `${s.label}（已移除）` : s.label,
          provider: s.provider,
          quota: s.quota,
          removed: Boolean(s.removedAt),
          ...(await supplierUsage(s.id, since)),
        })),
      ),
    );
  } catch (e) {
    return jsonError(e);
  }
}
