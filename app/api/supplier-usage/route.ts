import { jsonError } from "@/lib/auth";
import { cloudDbProxy } from "@/lib/cloud-api";
import { listSources } from "@/lib/sources";
import { supplierUsage } from "@/lib/store";

export const dynamic = "force-dynamic";

const WEEK_MS = 7 * 24 * 3600_000;

export async function GET(req: Request) {
  const proxied = await cloudDbProxy(req);
  if (proxied) return proxied;
  try {
    const since = Date.now() - WEEK_MS;
    const sources = (await listSources()).filter((s) => s.authType === "oauth_sub");
    return Response.json(
      await Promise.all(
        sources.map(async (s) => ({
          sourceId: s.id,
          label: s.label,
          provider: s.provider,
          quota: s.quota,
          ...(await supplierUsage(s.id, since)),
        })),
      ),
    );
  } catch (e) {
    return jsonError(e);
  }
}
