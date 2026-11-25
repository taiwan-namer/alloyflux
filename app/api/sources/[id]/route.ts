import { jsonError, requireSupplier, requireUser } from "@/lib/auth";
import { cloudDbProxy } from "@/lib/cloud-api";
import { assertSourceOwnedBy, deleteSource, getSourceKind, updateSource } from "@/lib/sources";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const proxied = await cloudDbProxy(req);
  if (proxied) return proxied;
  try {
    const { id } = await params;
    const patch = (await req.json()) as {
      enabled?: boolean;
      priority?: number;
      monthlyCapPoints?: number | null;
      shareLimitPct?: number;
    };
    const keys = Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined);
    // 節點託管貨源啟停：只要已登入即可（後台操作用），不必 ADMIN／supplier／owner
    const enabledOnly = keys.length === 1 && keys[0] === "enabled" && typeof patch.enabled === "boolean";
    if (enabledOnly) {
      const user = await requireUser(req);
      const kind = await getSourceKind(id);
      if (!kind) return Response.json({ error: "找不到貨源" }, { status: 404 });
      if (kind === "platform" && !user.isAdmin) {
        return Response.json({ error: "僅管理員可啟停平台直連貨源" }, { status: 403 });
      }
      await updateSource(id, { enabled: patch.enabled });
      return Response.json({ ok: true, enabled: patch.enabled });
    }
    const user = await requireSupplier(req);
    await assertSourceOwnedBy(id, user);
    await updateSource(id, patch);
    return Response.json({ ok: true });
  } catch (e) {
    return jsonError(e);
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const proxied = await cloudDbProxy(req);
  if (proxied) return proxied;
  try {
    const user = await requireSupplier(req);
    const { id } = await params;
    await assertSourceOwnedBy(id, user);
    await deleteSource(id);
    return Response.json({ ok: true });
  } catch (e) {
    return jsonError(e);
  }
}
