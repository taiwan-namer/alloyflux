import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { alignedTail, slideMessagesForUpstream } from "../lib/context-window";
import type { ChatMessage } from "../lib/providers";

for (const line of readFileSync(".env.production.local", "utf8").split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("=");
  if (i < 0) continue;
  const k = t.slice(0, i).trim();
  const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  if (!process.env[k]) process.env[k] = v;
}

const convId = process.argv[2] ?? "b6276ecf-788f-4a3d-a304-ee1229b89eeb";
const h = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 8);

async function main() {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1, idle_timeout: 5 });
  const rows = await sql<{ role: string; content: string; created_at: string; input_tokens: number | null }[]>`
    SELECT role, content, created_at, input_tokens FROM messages
    WHERE conversation_id = ${convId} ORDER BY created_at ASC
  `;
  await sql.end({ timeout: 5 });

  // Rebuild what the chat route sent at each user turn (same functions as app/api/chat/route.ts)
  const sent: { at: string; msgs: ChatMessage[]; input: number | null }[] = [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i]!.role !== "user") continue;
    const prior = rows.slice(0, i).filter((m) => m.content.trim());
    const full = alignedTail(
      [...prior.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })), {
        role: "user" as const,
        content: rows[i]!.content,
      }],
      80,
    );
    const next = rows[i + 1];
    sent.push({
      at: new Date(Number(rows[i]!.created_at)).toISOString().slice(11, 19),
      msgs: slideMessagesForUpstream(full),
      input: next?.role === "assistant" ? next.input_tokens : null,
    });
  }

  console.log(`conv=${convId} userTurns=${sent.length}`);
  for (let t = 1; t < sent.length; t++) {
    const a = sent[t - 1]!.msgs;
    const b = sent[t]!.msgs;
    let same = 0;
    while (same < a.length && same < b.length && h(a[same]) === h(b[same])) same++;
    const firstDiff = same < b.length ? b[same] : null;
    const prevAtDiff = same < a.length ? a[same] : null;
    const sharedChars = b.slice(0, same).reduce((n, m) => n + m.content.length, 0);
    const totalChars = b.reduce((n, m) => n + m.content.length, 0);
    console.log(
      JSON.stringify({
        turn: t,
        at: sent[t]!.at,
        input: sent[t]!.input,
        prevItems: a.length,
        items: b.length,
        samePrefixItems: same,
        sharedPct: totalChars ? Math.round((sharedChars / totalChars) * 100) : 0,
        diffAt: firstDiff
          ? {
              role: firstDiff.role,
              prevLen: prevAtDiff?.content.length ?? null,
              nowLen: firstDiff.content.length,
              prevHead: prevAtDiff?.content.slice(0, 40) ?? null,
              nowHead: firstDiff.content.slice(0, 40),
            }
          : null,
      }),
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
