import { cloudDbProxy } from "@/lib/cloud-api";
import { authenticateStrategyReader } from "@/lib/platform-api-auth";
import { listStrategyTemplatesFromDb } from "@/lib/strategy-loop";
import { DEFAULT_3_AI_PRESET, toPublicStrategyTemplate } from "@/lib/strategy-templates";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const proxied = await cloudDbProxy(req);
  if (proxied) return proxied;
  const auth = await authenticateStrategyReader(req);
  if (!auth) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const templates = (await listStrategyTemplatesFromDb({ includeDisabled: false })).map(
    toPublicStrategyTemplate,
  );

  return Response.json({ templates, default3AiPreset: DEFAULT_3_AI_PRESET });
}
