import { jsonError, requireSupplier } from "@/lib/auth";
import { cloudDbProxy } from "@/lib/cloud-api";
import { assertSourceOwnedBy, deleteSource, updateSource } from "@/lib/sources";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const proxied = await cloudDbProxy(req);
  if (proxied) return proxied;
  try {
    const user = await requireSupplier(req);
    const { id } = await params;
    await assertSourceOwnedBy(id, user);
    const patch = (await req.json()) as {
      enabled?: boolean;
      priority?: number;
      monthlyCapPoints?: number | null;
      shareLimitPct?: number;
    };
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
