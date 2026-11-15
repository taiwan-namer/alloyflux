import { authenticateNode, touchHeartbeat } from "@/lib/node-registry";
import { jobPublicForNode, pollJobForNode } from "@/lib/inference-jobs";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function bearer(req: Request): string {
  const h = req.headers.get("authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() || "";
}

/** Long poll：只回傳指派給此節點的任務（含簽章，無 API Key／OAuth） */
export async function POST(req: Request) {
  const node = await authenticateNode(bearer(req));
  if (!node) return Response.json({ error: "節點憑證無效" }, { status: 401 });
  if (node.status === "revoked") return Response.json({ error: "節點已撤銷" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as {
    acceptingJobs?: boolean;
    activeJobs?: number;
    waitMs?: number;
  };

  await touchHeartbeat(node.id, {
    acceptingJobs: body.acceptingJobs,
    activeJobs: body.activeJobs,
  });

  if (body.acceptingJobs === false || node.status === "paused") {
    return Response.json({ job: null, reason: "not_accepting" });
  }

  const waitMs = Math.min(Math.max(body.waitMs ?? 25_000, 1000), 55_000);
  const got = await pollJobForNode(node.id, waitMs);
  if (!got) return Response.json({ job: null });

  return Response.json({
    job: jobPublicForNode(got.job),
    signature: got.signature,
  });
}
