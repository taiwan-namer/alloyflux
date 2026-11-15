import { jsonError, requireAdmin } from "@/lib/auth";
import { registerNode, type RegisterCapabilityInput } from "@/lib/node-registry";

export const dynamic = "force-dynamic";

function authorizeRegister(req: Request): void {
  const token = process.env.AGENT_REGISTER_TOKEN?.trim();
  const h = req.headers.get("authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (token && m?.[1]?.trim() === token) return;
  requireAdmin(req);
}

/** Agent 註冊：需管理員 Session，或 Bearer AGENT_REGISTER_TOKEN */
export async function POST(req: Request) {
  try {
    authorizeRegister(req);
    const body = (await req.json().catch(() => ({}))) as {
      label?: string;
      accountName?: string;
      maxConcurrency?: number;
      dailyJobLimit?: number;
      capabilities?: RegisterCapabilityInput[];
    };

    const { node, credential } = registerNode({
      label: body.label,
      accountName: body.accountName,
      maxConcurrency: body.maxConcurrency,
      dailyJobLimit: body.dailyJobLimit,
      capabilities: body.capabilities?.length
        ? body.capabilities
        : [{ authSourceType: "mock", providerKey: "mock", modelId: "node-mock" }],
    });
    return Response.json({
      ok: true,
      nodeId: node.id,
      credential,
      note: "請妥善保存 credential；平台不保存明文，遺失需重新註冊。",
    });
  } catch (e) {
    return jsonError(e);
  }
}
