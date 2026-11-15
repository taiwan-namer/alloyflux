/**
 * Supabase Postgres 存取層。
 * 保留 SQLite 風格 prepare/get/all/run，方便既有呼叫端遷移（皆改為 async）。
 *
 * 環境變數（擇一）：
 * - DATABASE_URL / POSTGRES_URL / SUPABASE_DB_URL
 * 建議用 Transaction pooler（埠 6543）+ ?pgbouncer=true
 */
import postgres, { type Sql } from "postgres";

export type SqlClient = Sql<{ bigint: number }>;

export type Statement = {
  get: (...params: unknown[]) => Promise<Record<string, unknown> | undefined>;
  all: (...params: unknown[]) => Promise<Record<string, unknown>[]>;
  run: (...params: unknown[]) => Promise<{ changes: number }>;
};

export type Db = {
  prepare: (sql: string) => Statement;
  exec: (sql: string) => Promise<void>;
  /** 以單一連線跑交易；取代 BEGIN/COMMIT/ROLLBACK */
  transaction: <T>(fn: (tx: Db) => Promise<T>) => Promise<T>;
};

const globalForDb = globalThis as unknown as {
  __pg?: SqlClient;
  __pgUrl?: string;
};

function databaseUrl(): string {
  const url =
    process.env.DATABASE_URL?.trim() ||
    process.env.POSTGRES_URL?.trim() ||
    process.env.SUPABASE_DB_URL?.trim() ||
    "";
  if (!url) {
    throw new Error(
      "缺少 DATABASE_URL（Supabase：Project Settings → Database → Connection string / URI）",
    );
  }
  return url;
}

function createSql(url: string): SqlClient {
  const usePooler = /pooler\.supabase\.com|:6543|pgbouncer=true/i.test(url);
  return postgres(url, {
    max: usePooler ? 4 : 8,
    idle_timeout: 20,
    connect_timeout: 30,
    prepare: !usePooler,
    ssl: "require",
    transform: { undefined: null },
    // BIGINT → Number（時間戳／計數；勿存超過 Number.MAX_SAFE_INTEGER 的值）
    types: {
      bigint: {
        to: 20,
        from: [20],
        parse: (x: string) => Number(x),
        serialize: (x: number) => String(x),
      },
    },
  });
}

function sqlClient(): SqlClient {
  const url = databaseUrl();
  if (!globalForDb.__pg || globalForDb.__pgUrl !== url) {
    void globalForDb.__pg?.end({ timeout: 1 }).catch(() => {});
    globalForDb.__pg = createSql(url);
    globalForDb.__pgUrl = url;
  }
  return globalForDb.__pg;
}

/** `?` → `$1,$2,…`；`INSERT OR IGNORE` → `ON CONFLICT DO NOTHING` */
export function adaptSql(sql: string): string {
  let i = 0;
  let out = sql.replace(/\bINSERT\s+OR\s+IGNORE\b/gi, "INSERT");
  const needsIgnore = /\bINSERT\s+OR\s+IGNORE\b/i.test(sql);
  out = out.replace(/\?/g, () => `$${++i}`);
  if (needsIgnore) {
    // 放在語句末尾（假設無 RETURNING）；有 RETURNING 時插在其前
    if (/\bRETURNING\b/i.test(out)) {
      out = out.replace(/\bRETURNING\b/i, "ON CONFLICT DO NOTHING RETURNING");
    } else {
      out = `${out.replace(/;\s*$/, "")} ON CONFLICT DO NOTHING`;
    }
  }
  return out;
}

function bindStatement(client: SqlClient, sql: string): Statement {
  const adapted = adaptSql(sql);
  return {
    async get(...params: unknown[]) {
      const rows = await client.unsafe(adapted, params as never[]);
      return (rows[0] as Record<string, unknown> | undefined) ?? undefined;
    },
    async all(...params: unknown[]) {
      const rows = await client.unsafe(adapted, params as never[]);
      return rows as unknown as Record<string, unknown>[];
    },
    async run(...params: unknown[]) {
      const rows = await client.unsafe(adapted, params as never[]);
      const changes = typeof rows.count === "number" ? rows.count : rows.length;
      return { changes };
    },
  };
}

function wrapClient(client: SqlClient): Db {
  return {
    prepare(sql: string) {
      return bindStatement(client, sql);
    },
    async exec(sql: string) {
      const trimmed = sql.trim();
      if (/^(BEGIN|COMMIT|ROLLBACK)\b/i.test(trimmed)) {
        throw new Error(`請改用 db().transaction(...)，勿直接 ${trimmed.split(/\s/)[0]}`);
      }
      await client.unsafe(adaptSql(sql));
    },
    transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      return client.begin(async (txSql) => fn(wrapClient(txSql as unknown as SqlClient))) as Promise<T>;
    },
  };
}

export function db(): Db {
  return wrapClient(sqlClient());
}

export function newId(): string {
  return crypto.randomUUID();
}
