import { cloudDbProxy } from "@/lib/cloud-api";
import { authenticateStrategyReader } from "@/lib/platform-api-auth";
import { DEFAULT_3_AI_PRESET, listStrategyTemplates } from "@/lib/strategy-templates";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const proxied = await cloudDbProxy(req);
  if (proxied) return proxied;
  const auth = await authenticateStrategyReader(req);
  if (!auth) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const templates = listStrategyTemplates().map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    stages: t.stages,
    quickPrompts: t.quickPrompts,
    recommendedModels: t.recommendedModels,
  }));

  return Response.json({ templates, default3AiPreset: DEFAULT_3_AI_PRESET });
}
