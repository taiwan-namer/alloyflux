import { jsonError, requireSupplier } from "@/lib/auth";
import { deleteSource, updateSource } from "@/lib/sources";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireSupplier(req);
    const { id } = await params;
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
  try {
    await requireSupplier(req);
    const { id } = await params;
    await deleteSource(id);
    return Response.json({ ok: true });
  } catch (e) {
    return jsonError(e);
  }
}
