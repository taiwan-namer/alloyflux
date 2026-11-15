import { jsonError, requireAdmin } from "@/lib/auth";
import { listNodes } from "@/lib/node-registry";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    requireAdmin(req);
    const nodes = listNodes();
    return Response.json({
      online: nodes.filter((n) => n.online).length,
      total: nodes.length,
      nodes: nodes.map((n) => ({
        id: n.id,
        label: n.label,
        online: n.online,
        status: n.status,
        acceptingJobs: n.acceptingJobs,
        lastSeenAt: n.lastSeenAt,
        capabilities: n.capabilities.map((c) => `${c.providerKey}:${c.modelId}`),
      })),
      note: "Agent 主動 long poll，無需公開住宅 IP／Port Forward／住宅代理。",
    });
  } catch (e) {
    return jsonError(e);
  }
}
