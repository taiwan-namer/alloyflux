import { jsonError, requireAdmin } from "@/lib/auth";
import { cloudDbProxy } from "@/lib/cloud-api";
import {
  latestModelCatalogSnapshot,
  refreshAllModelCatalogs,
} from "@/lib/model-catalog-refresh";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const proxied = await cloudDbProxy(req);
  if (proxied) return proxied;
  try {
    await requireAdmin(req);
    const latest = await latestModelCatalogSnapshot();
    return Response.json({ ok: true, latest });
  } catch (e) {
    return jsonError(e);
  }
}

export async function POST(req: Request) {
  const proxied = await cloudDbProxy(req);
  if (proxied) return proxied;
  try {
    await requireAdmin(req);
    const report = await refreshAllModelCatalogs();
    return Response.json({ ok: true, report });
  } catch (e) {
    return jsonError(e);
  }
}
