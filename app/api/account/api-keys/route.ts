import { jsonError, requireUser } from "@/lib/auth";
import { createUserApiKey, listUserApiKeys } from "@/lib/store";

export const dynamic = "force-dynamic";

/** 列出目前金鑰（只回 hint，不含完整密鑰） */
export async function GET(req: Request) {
  try {
    const user = requireUser(req);
    return Response.json(
      { keys: listUserApiKeys(user.id) },
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

/** 新增一把金鑰；回應含完整 apiKey（僅此一次） */
export async function POST(req: Request) {
  try {
    const user = requireUser(req);
    const body = (await req.json().catch(() => ({}))) as { label?: string };
    const created = createUserApiKey(user.id, body.label);
    return Response.json(
      {
        key: {
          id: created.id,
          label: created.label,
          keyHint: created.keyHint,
          createdAt: created.createdAt,
        },
        apiKey: created.apiKey,
        keys: listUserApiKeys(user.id),
      },
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
