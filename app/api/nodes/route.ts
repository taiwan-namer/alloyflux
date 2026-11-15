import { jsonError, requireAdmin } from "@/lib/auth";
import { listNodes, revokeNode } from "@/lib/node-registry";
import { listEarnings } from "@/lib/supplier-settlement";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    const nodes = (await listNodes()).map((n) => ({
      id: n.id,
      accountId: n.accountId,
      accountName: n.accountName,
      label: n.label,
      status: n.status,
      online: n.online,
      acceptingJobs: n.acceptingJobs,
      maxConcurrency: n.maxConcurrency,
      dailyJobLimit: n.dailyJobLimit,
      jobsToday: n.jobsToday,
      lastSeenAt: n.lastSeenAt,
      credentialHint: n.credentialHint,
      capabilities: n.capabilities,
      createdAt: n.createdAt,
    }));
    return Response.json({ nodes, earnings: await listEarnings() });
  } catch (e) {
    return jsonError(e);
  }
}

export async function DELETE(req: Request) {
  try {
    await requireAdmin(req);
    const id = new URL(req.url).searchParams.get("id");
    if (!id) return Response.json({ error: "缺少 id" }, { status: 400 });
    await revokeNode(id);
    return Response.json({ ok: true });
  } catch (e) {
    return jsonError(e);
  }
}
