import { jsonError } from "@/lib/auth";
import { cloudApiBase, hasLocalDatabaseUrl } from "@/lib/oauth-persist";
import { BASE_URL } from "@/lib/providers";
import { addSource, listSources, type SourceKind, type SourceProvider } from "@/lib/sources";

export const dynamic = "force-dynamic";

/** 供給者／管理員：綁訂閱與 API Key 貨源 */
export async function GET(req: Request) {
  try {
    if (!hasLocalDatabaseUrl()) {
      // 本機無 DB：改讀雲端貨源列表（與線上 /sources 同一資料）
      if (req.headers.get("x-oauth-no-proxy") !== "1") {
        try {
          const res = await fetch(`${cloudApiBase()}/api/sources`, {
            cache: "no-store",
            headers: { "x-oauth-no-proxy": "1" },
          });
          if (res.ok) {
            const data = await res.json();
            return Response.json(data);
          }
        } catch {
          // fall through
        }
      }
      return Response.json(
        { error: "本機未設定 DATABASE_URL，且無法讀取雲端貨源" },
        { status: 503 },
      );
    }
    return Response.json(await listSources());
  } catch (e) {
    return jsonError(e);
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      label?: string;
      kind: SourceKind;
      provider: SourceProvider;
      apiKey: string;
      priority?: number;
      monthlyCapPoints?: number | null;
    };
    if (!["supplier", "platform"].includes(body.kind)) return Response.json({ error: "kind 不正確" }, { status: 400 });
    if (!["gemini", "openai", "anthropic", "xai", "openrouter"].includes(body.provider))
      return Response.json({ error: "provider 不正確" }, { status: 400 });
    if (!body.apiKey?.trim()) return Response.json({ error: "請填入 API Key" }, { status: 400 });

    const check = await verifyKey(body.provider, body.apiKey.trim());
    if (!check.ok) return Response.json({ error: `Key 驗證失敗：${check.message}` }, { status: 400 });

    await addSource({
      label: body.label ?? "",
      kind: body.kind,
      provider: body.provider,
      apiKey: body.apiKey,
      priority: body.priority,
      monthlyCapPoints: body.monthlyCapPoints ?? null,
    });
    return Response.json({ ok: true });
  } catch (e) {
    return jsonError(e);
  }
}

async function verifyKey(provider: SourceProvider, apiKey: string): Promise<{ ok: boolean; message: string }> {
  const req: { url: string; headers: Record<string, string> } =
    provider === "gemini"
      ? { url: `${BASE_URL.gemini}/models?key=${encodeURIComponent(apiKey)}`, headers: {} }
      : provider === "anthropic"
        ? { url: `${BASE_URL.anthropic}/models`, headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" } }
        : provider === "openai"
          ? { url: `${BASE_URL.openai}/models`, headers: { authorization: `Bearer ${apiKey}` } }
          : provider === "xai"
            ? { url: `${BASE_URL.xai}/models`, headers: { authorization: `Bearer ${apiKey}` } }
            : { url: `${BASE_URL.openrouter}/key`, headers: { authorization: `Bearer ${apiKey}` } };
  try {
    const res = await fetch(req.url, { headers: req.headers });
    if (res.ok) return { ok: true, message: "ok" };
    return { ok: false, message: `${res.status} ${(await res.text()).slice(0, 200)}` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "network error" };
  }
}
