import sqlite3

p = r"C:\Users\Admin\MyProjects\binance\data\app.db"
con = sqlite3.connect(p)
cur = con.cursor()
tables = [t[0] for t in cur.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
print("tables", tables)
for t in tables:
    if any(k in t.lower() for k in ("source", "oauth", "user", "message", "conversation")):
        cols = [c[1] for c in cur.execute(f"PRAGMA table_info({t})").fetchall()]
        n = cur.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
        print(f"{t}: rows={n} cols={cols}")
if "sources" in tables:
    rows = cur.execute(
        "SELECT id, label, provider, auth_type, enabled, length(encrypted_key), key_hint FROM sources"
    ).fetchall()
    for r in rows:
        print("source", r)
con.close()
