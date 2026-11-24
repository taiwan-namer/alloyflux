import { jsonError, requireAdmin } from "@/lib/auth";
import { cloudDbProxy } from "@/lib/cloud-api";
import {
  createStrategyTemplate,
  listStrategyTemplatesFromDb,
} from "@/lib/strategy-loop";
import type { RecommendedModelSlot } from "@/lib/strategy-templates";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const proxied = await cloudDbProxy(req);
  if (proxied) return proxied;
  try {
    await requireAdmin(req);
    const templates = await listStrategyTemplatesFromDb({ includeDisabled: true });
    return Response.json({ templates });
  } catch (e) {
    return jsonError(e);
  }
}

export async function POST(req: Request) {
  const proxied = await cloudDbProxy(req);
  if (proxied) return proxied;
  try {
    await requireAdmin(req);
    const body = (await req.json().catch(() => ({}))) as {
      id?: string;
      name?: string;
      description?: string;
      stages?: string[];
      quickPrompts?: string[];
      recommendedModels?: RecommendedModelSlot[];
      systemPrompt?: string;
      streamLeadPreface?: string;
      enabled?: boolean;
      sortOrder?: number;
    };
    if (!body.id?.trim() || !body.name?.trim()) {
      return Response.json({ error: "id 與 name 必填" }, { status: 400 });
    }
    const created = await createStrategyTemplate({
      id: body.id,
      name: body.name,
      description: body.description,
      stages: body.stages,
      quickPrompts: body.quickPrompts,
      recommendedModels: body.recommendedModels,
      systemPrompt: body.systemPrompt,
      streamLeadPreface: body.streamLeadPreface,
      enabled: body.enabled,
      sortOrder: body.sortOrder,
    });
    return Response.json({ ok: true, template: created });
  } catch (e) {
    return jsonError(e);
  }
}
