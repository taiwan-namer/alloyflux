import { authenticateNode, revokeNode } from "@/lib/node-registry";

export const dynamic = "force-dynamic";

function bearer(req: Request): string {
  const h = req.headers.get("authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() || "";
}

/** 供給者撤銷自己的節點 */
export async function POST(req: Request) {
  const node = await authenticateNode(bearer(req));
  if (!node) return Response.json({ error: "節點憑證無效" }, { status: 401 });
  await revokeNode(node.id);
  return Response.json({ ok: true, nodeId: node.id, status: "revoked" });
}
