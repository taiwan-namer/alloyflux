import { jsonError, requireAdmin } from "@/lib/auth";
import { cloudDbProxy } from "@/lib/cloud-api";
import {
  deleteStrategyTemplate,
  getStrategyTemplateById,
  updateStrategyTemplate,
} from "@/lib/strategy-loop";
import type { RecommendedModelSlot } from "@/lib/strategy-templates";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const proxied = await cloudDbProxy(req);
  if (proxied) return proxied;
  try {
    await requireAdmin(req);
    const { id } = await ctx.params;
    const template = await getStrategyTemplateById(id);
    if (template.id !== id) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    return Response.json({ template });
  } catch (e) {
    return jsonError(e);
  }
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const proxied = await cloudDbProxy(req);
  if (proxied) return proxied;
  try {
    await requireAdmin(req);
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as {
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
    const updated = await updateStrategyTemplate(id, {
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
    if (!updated) return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json({ ok: true, template: updated });
  } catch (e) {
    return jsonError(e);
  }
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const proxied = await cloudDbProxy(req);
  if (proxied) return proxied;
  try {
    await requireAdmin(req);
    const { id } = await ctx.params;
    const result = await deleteStrategyTemplate(id);
    if (!result.ok) {
      const status = result.error === "not found" ? 404 : 400;
      return Response.json({ error: result.error }, { status });
    }
    return Response.json({ ok: true });
  } catch (e) {
    return jsonError(e);
  }
}
