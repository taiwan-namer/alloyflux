import { jsonError, requireUser } from "@/lib/auth";
import {
  deleteUserMemory,
  listUserMemoryRows,
  upsertUserMemory,
  type MemoryCategory,
} from "@/lib/store";

export const dynamic = "force-dynamic";

function parseCategory(raw: unknown): MemoryCategory | undefined {
  if (raw === "style" || raw === "fact") return raw;
  return undefined;
}

/** GET：列出目前使用者的 fact／style 記憶 */
export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    const url = new URL(req.url);
    const category = parseCategory(url.searchParams.get("category"));
    const rows = await listUserMemoryRows(user.id, category, 40);
    return Response.json({
      memories: rows,
      style: rows.filter((r) => r.category === "style"),
      fact: rows.filter((r) => r.category === "fact"),
    });
  } catch (e) {
    return jsonError(e);
  }
}

/** POST：手動新增一條 fact 或 style */
export async function POST(req: Request) {
  try {
    const user = await requireUser(req);
    const body = (await req.json()) as { fact?: string; text?: string; category?: string };
    const text = String(body.fact ?? body.text ?? "").trim();
    const category = parseCategory(body.category) ?? "fact";
    if (!text) return jsonError(Object.assign(new Error("請輸入記憶內容"), { status: 400 }));
    const row = await upsertUserMemory(user.id, text, category);
    if (!row) return jsonError(Object.assign(new Error("內容過短、過長或含敏感資訊"), { status: 400 }));
    return Response.json({ ok: true, memory: row });
  } catch (e) {
    return jsonError(e);
  }
}

/** DELETE：刪除指定記憶（?id=） */
export async function DELETE(req: Request) {
  try {
    const user = await requireUser(req);
    const url = new URL(req.url);
    const id = url.searchParams.get("id")?.trim();
    if (!id) return jsonError(Object.assign(new Error("缺少記憶 id"), { status: 400 }));
    const ok = await deleteUserMemory(user.id, id);
    if (!ok) return jsonError(Object.assign(new Error("找不到該記憶"), { status: 404 }));
    return Response.json({ ok: true });
  } catch (e) {
    return jsonError(e);
  }
}
