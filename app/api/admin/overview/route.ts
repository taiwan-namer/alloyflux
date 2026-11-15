import { jsonError } from "@/lib/auth";
import { db } from "@/lib/db";
import { taipeiDayStartMs } from "@/lib/free-tier";
import { listNodes } from "@/lib/node-registry";
import { cloudApiBase, hasLocalDatabaseUrl } from "@/lib/oauth-persist";
import { listSources } from "@/lib/sources";
import { listEarnings } from "@/lib/supplier-settlement";

export const dynamic = "force-dynamic";

async function settled<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch {
    return fallback;
  }
}

/** 本機無 DB 時改讀雲端總覽（與 /sources 同一份 Supabase 資料） */
async function fetchCloudOverview(req: Request): Promise<Response | null> {
  if (req.headers.get("x-admin-no-proxy") === "1") return null;
  try {
    const res = await fetch(`${cloudApiBase()}/api/admin/overview`, {
      cache: "no-store",
      headers: { "x-admin-no-proxy": "1" },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return Response.json({ ...data, _fromCloud: true, _cloudApiBase: cloudApiBase() });
  } catch {
    return null;
  }
}

async function fetchCloudSources(): Promise<Awaited<ReturnType<typeof listSources>>> {
  try {
    const res = await fetch(`${cloudApiBase()}/api/sources`, {
      cache: "no-store",
      headers: { "x-oauth-no-proxy": "1" },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export async function GET(req: Request) {
  try {
    // 本機開發常無 DATABASE_URL：直接代理雲端，否則後台水庫全 0
    if (!hasLocalDatabaseUrl()) {
      const cloud = await fetchCloudOverview(req);
      if (cloud) return cloud;
      const sources = await fetchCloudSources();
      return Response.json({
        stats: {
          totalUsers: 0,
          totalPartners: 0,
          oauthSupplierSources: sources.filter((s) => s.kind === "supplier").length,
          partnerNodes: sources.filter((s) => s.kind === "supplier").length,
          todayMessages: 0,
          todayFreeMessages: 0,
          weekTopupPoints: 0,
          weekSourceCostPoints: 0,
          enabledSources: sources.filter((s) => s.enabled).length,
          totalSources: sources.length,
          onlineNodes: 0,
          totalNodes: 0,
        },
        sources,
        nodes: [],
        earnings: [],
        jobStats: [],
        recentUsers: [],
        recentLedger: [],
        _fromCloud: true,
        _cloudApiBase: cloudApiBase(),
        _partial: true,
      });
    }

    const dayStart = taipeiDayStartMs();
    const weekStart = Date.now() - 7 * 86_400_000;

    const sources = await settled(listSources(), []);
    const [nodes, earnings] = await Promise.all([
      settled(listNodes(), []),
      settled(listEarnings(), []),
    ]);

    const d = db();
    const emptyRow = { n: 0, s: 0 };
    const [
      usersCountRow,
      suppliersCountRow,
      todayMsgRow,
      todayFreeMsgRow,
      weekRevenueRow,
      weekCostRow,
      recentUsers,
      recentLedger,
      jobStatsRows,
    ] = await Promise.all([
      settled(d.prepare("SELECT COUNT(*) AS n FROM users").get(), emptyRow),
      settled(d.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'supplier'").get(), emptyRow),
      settled(
        d.prepare("SELECT COUNT(*) AS n FROM messages WHERE role = 'assistant' AND created_at >= ?").get(dayStart),
        emptyRow,
      ),
      settled(
        d
          .prepare(
            "SELECT COUNT(*) AS n FROM messages WHERE role = 'assistant' AND COALESCE(charged_points, 0) = 0 AND created_at >= ?",
          )
          .get(dayStart),
        emptyRow,
      ),
      settled(
        d
          .prepare("SELECT COALESCE(SUM(amount_points), 0) AS s FROM ledger WHERE type = 'topup' AND created_at >= ?")
          .get(weekStart),
        emptyRow,
      ),
      settled(
        d
          .prepare(
            "SELECT COALESCE(SUM(amount_points), 0) AS s FROM ledger WHERE type = 'source_usage' AND created_at >= ?",
          )
          .get(weekStart),
        emptyRow,
      ),
      settled(
        d
          .prepare(
            `SELECT u.id, u.email, u.name, u.role, u.created_at AS "createdAt",
                  COALESCE((SELECT SUM(amount_points) FROM ledger l WHERE l.user_id = u.id AND l.type IN ('topup', 'usage')), 0) AS balance
           FROM users u
           ORDER BY u.created_at DESC
           LIMIT 50`,
          )
          .all(),
        [] as Record<string, unknown>[],
      ),
      settled(
        d
          .prepare(
            `SELECT id, user_id AS "userId", type, amount_points AS "amountPoints", ref_id AS "refId", note, created_at AS "createdAt"
           FROM ledger
           ORDER BY created_at DESC
           LIMIT 60`,
          )
          .all(),
        [] as Record<string, unknown>[],
      ),
      settled(
        d
          .prepare(
            `SELECT status, COUNT(*) AS n
           FROM inference_jobs
           WHERE created_at >= ?
           GROUP BY status`,
          )
          .all(dayStart),
        [] as Record<string, unknown>[],
      ),
    ]);

    const oauthSupplierSources = sources.filter((s) => s.kind === "supplier").length;
    const rolePartners = Number(suppliersCountRow?.n ?? 0);

    return Response.json({
      stats: {
        totalUsers: Number(usersCountRow?.n ?? 0),
        totalPartners: rolePartners,
        oauthSupplierSources,
        partnerNodes: oauthSupplierSources,
        todayMessages: Number(todayMsgRow?.n ?? 0),
        todayFreeMessages: Number(todayFreeMsgRow?.n ?? 0),
        weekTopupPoints: Math.round(Number(weekRevenueRow?.s ?? 0) * 100) / 100,
        weekSourceCostPoints: Math.round(Number(weekCostRow?.s ?? 0) * 100) / 100,
        enabledSources: sources.filter((s) => s.enabled).length,
        totalSources: sources.length,
        onlineNodes: nodes.filter((n) => n.online).length,
        totalNodes: nodes.length,
      },
      sources,
      nodes,
      earnings,
      jobStats: jobStatsRows.map((r) => ({ status: String(r.status), count: Number(r.n) })),
      recentUsers: recentUsers.map((u) => ({
        id: String(u.id),
        email: String(u.email),
        name: String(u.name),
        role: String(u.role),
        balance: Number(u.balance ?? 0),
        createdAt: Number(u.createdAt ?? 0),
      })),
      recentLedger: recentLedger.map((l) => ({
        id: String(l.id),
        userId: String(l.userId),
        type: String(l.type),
        amountPoints: Number(l.amountPoints ?? 0),
        refId: l.refId ? String(l.refId) : null,
        note: l.note ? String(l.note) : null,
        createdAt: Number(l.createdAt ?? 0),
      })),
    });
  } catch (e) {
    return jsonError(e);
  }
}
