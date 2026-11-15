import { jsonError, requireUser } from "@/lib/auth";
import { deleteUserApiKey, listUserApiKeys } from "@/lib/store";

export const dynamic = "force-dynamic";

/** 刪除／撤銷指定金鑰（立即失效） */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = requireUser(req);
    const { id } = await ctx.params;
    if (!id?.trim()) return Response.json({ error: "缺少金鑰 id" }, { status: 400 });
    const ok = deleteUserApiKey(user.id, id.trim());
    if (!ok) return Response.json({ error: "找不到金鑰或無權限" }, { status: 404 });
    return Response.json(
      { ok: true, keys: listUserApiKeys(user.id) },
      {
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate",
          Pragma: "no-cache",
        },
      },
    );
  } catch (e) {
    return jsonError(e);
  }
}
