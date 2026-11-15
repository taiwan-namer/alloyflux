import { jsonError, requireUser } from "@/lib/auth";
import { createUserApiKey, listUserApiKeys } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * 相容舊前端：POST 改為「新增一把金鑰」（不再覆寫唯一金鑰）。
 * 新介面請改用 /api/account/api-keys。
 */
export async function POST(req: Request) {
  try {
    const user = requireUser(req);
    const body = (await req.json().catch(() => ({}))) as { label?: string };
    const created = createUserApiKey(user.id, body.label ?? "新金鑰");
    return Response.json(
      {
        apiKey: created.apiKey,
        key: {
          id: created.id,
          label: created.label,
          keyHint: created.keyHint,
          createdAt: created.createdAt,
        },
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
