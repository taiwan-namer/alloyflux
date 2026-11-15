import { authenticateNode, touchHeartbeat } from "@/lib/node-registry";

export const dynamic = "force-dynamic";

function bearer(req: Request): string {
  const h = req.headers.get("authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() || "";
}

export async function POST(req: Request) {
  const node = await authenticateNode(bearer(req));
  if (!node) return Response.json({ error: "節點憑證無效" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as {
    activeJobs?: number;
    acceptingJobs?: boolean;
    meta?: Record<string, unknown>;
  };

  await touchHeartbeat(node.id, {
    activeJobs: body.activeJobs,
    acceptingJobs: body.acceptingJobs,
    meta: body.meta,
  });

  return Response.json({
    ok: true,
    nodeId: node.id,
    status: node.status,
    serverTime: Date.now(),
  });
}
