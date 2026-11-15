import { decrypt } from "@/lib/crypto";
import { db } from "@/lib/db";
import { CATEGORY_LABEL, MODELS } from "@/lib/models";
import { fetchAntigravityAvailableModels, type OAuthCredentials } from "@/lib/oauth";
import { listOnlineNodesForModel } from "@/lib/node-registry";
import { listSources } from "@/lib/sources";

export const dynamic = "force-dynamic";

export async function GET() {
  const sources = (await listSources()).filter((s) => s.enabled);
  let antigravityIds = new Set<string>();
  try {
    const row = (await db()
      .prepare(
        "SELECT encrypted_key FROM sources WHERE auth_type = 'oauth_sub' AND provider = 'gemini' AND enabled = 1 LIMIT 1",
      )
      .get()) as { encrypted_key: string } | undefined;
    if (row) {
      const creds = JSON.parse(decrypt(row.encrypted_key)) as OAuthCredentials;
      antigravityIds = new Set(
        Object.keys(await fetchAntigravityAvailableModels(creds)),
      );
    }
  } catch {
    antigravityIds = new Set();
  }

  const hasGeminiOAuth = sources.some((s) => s.provider === "gemini" && s.authType === "oauth_sub");
  const hasOpenRouter = sources.some((s) => s.provider === "openrouter");

  return Response.json(
    await Promise.all(MODELS.map(async (m) => {
      let available = false;
      let note: string | undefined;

      if (m.category === "node-agent" || m.nodeProviderKey) {
        const pk = m.nodeProviderKey ?? (m.antigravityId ? "antigravity" : m.codexId ? "chatgpt-codex" : "");
        const up = m.nodeUpstreamModel ?? m.antigravityId ?? m.codexId ?? m.id;
        const online = pk ? (await listOnlineNodesForModel(pk, up)).length > 0 : false;
        available = online || m.id === "node-mock"; // mock 也要節點在線才真正跑；UI 仍顯示
        if (m.id === "node-mock") {
          available = (await listOnlineNodesForModel("mock", "node-mock")).length > 0;
          note = available ? "Node Agent Online" : "請啟動 Node Agent（npm run node-agent -- start）";
        } else if (!online) {
          note = "等待對應能力的 Node Agent 上線";
        }
      } else if (m.antigravityId) {
        if (hasGeminiOAuth && antigravityIds.size > 0) {
          available = antigravityIds.has(m.antigravityId);
          if (!available) note = "此訂閱帳號的 Antigravity 目錄目前未開放此模型";
        } else if (hasGeminiOAuth) {
          available = true;
        } else if (hasOpenRouter) {
          available = true;
          note = "目前僅 OpenRouter 備援（非供給者 Antigravity 訂閱）";
        } else if (m.provider === "gemini" && sources.some((s) => s.provider === "gemini")) {
          available = !m.category.startsWith("antigravity-");
        } else {
          note = "需要已連結的 Google Antigravity 訂閱或 Node Agent";
        }
      } else {
        available =
          sources.some((s) => s.provider === m.provider || s.provider === "openrouter") &&
          !(m.category === "antigravity-claude" || m.category === "antigravity-gpt");
        if (!available) note = "無可用貨源";
      }

      const effort = m.effort ?? null;
      const familyId = effort ? m.id.replace(/-(low|medium|high)$/, "") : m.id;
      const baseFamily = m.label.replace(/\s*·\s*(Low|Medium|High)\s*/g, "").trim();
      const familyLabel = m.blurb ? `${baseFamily}（${m.blurb}）` : baseFamily;

      return {
        id: m.id,
        label: m.label,
        familyId,
        familyLabel,
        provider: m.provider,
        category: m.category,
        categoryLabel: CATEGORY_LABEL[m.category],
        quotaPool: m.quotaPool,
        tier: m.tier,
        effort,
        price: m.price,
        available,
        note,
      };
    })),
  );
}
