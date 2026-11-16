/**
 * 單次 Flash grounding（本機 app.db OAuth prefer）：寫入 raw groundingSupports
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadEnvLocal() {
  const p = path.join(ROOT, ".env.local");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!(k in process.env)) process.env[k] = v;
  }
}

loadEnvLocal();
process.env.SUPPLIER_NODE_MODE = "1";
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
delete process.env.SUPABASE_DB_URL;

async function main() {
  const { DatabaseSync } = await import("node:sqlite");
  const { decrypt } = await import("../lib/crypto");
  const { fetchLiveResearchSearchHit } = await import("../lib/web-research");
  type OAuthCredentials = import("../lib/oauth").OAuthCredentials;

  const dbPath = path.join(ROOT, "data", "app.db");
  if (!existsSync(dbPath)) {
    console.error("STOP: no app.db");
    process.exit(2);
  }
  const db = new DatabaseSync(dbPath);
  const rows = db
    .prepare(
      "SELECT id, provider, encrypted_key FROM sources WHERE enabled = 1 AND auth_type = 'oauth_sub' AND provider = 'gemini'",
    )
    .all() as { id: string; provider: string; encrypted_key: string }[];
  if (!rows.length) {
    console.error("STOP: no gemini oauth");
    process.exit(2);
  }
  const creds = JSON.parse(decrypt(rows[0].encrypted_key)) as OAuthCredentials;
  const hit = await fetchLiveResearchSearchHit("NVIDIA 過去 7 天新聞重點", {
    prefer: { sourceId: rows[0].id, creds },
  });
  if (!hit) {
    console.error("Flash hit null");
    process.exit(2);
  }
  console.log(
    JSON.stringify(
      {
        provider: hit.provider,
        sourceCount: hit.sources.length,
        queryCount: hit.queries.length,
        supportCount: hit.rawGroundingSupports.length,
        briefPreview: hit.brief.slice(0, 240),
        supportsSample: hit.rawGroundingSupports.slice(0, 2),
        sourcesPreview: hit.sources.slice(0, 5),
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
