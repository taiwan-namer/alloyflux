import { jsonError, requireUser } from "@/lib/auth";
import { deleteConversation, getConversation, listMessages } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(req);
    const { id } = await ctx.params;
    const conversation = await getConversation(user.id, id);
    if (!conversation) return Response.json({ error: "找不到對話" }, { status: 404 });
    return Response.json({ conversation, messages: await listMessages(id) });
  } catch (e) {
    return jsonError(e);
  }
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(req);
    const { id } = await ctx.params;
    await deleteConversation(user.id, id);
    return Response.json({ ok: true });
  } catch (e) {
    return jsonError(e);
  }
}
