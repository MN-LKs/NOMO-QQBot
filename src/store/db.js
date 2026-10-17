const SCHEMA_VERSION = 4;

export const DDL = [
  `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`,
  `CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS stats (k TEXT PRIMARY KEY, v INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS daily (
     day TEXT PRIMARY KEY, visits INTEGER NOT NULL DEFAULT 0,
     messages INTEGER NOT NULL DEFAULT 0, projects INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS groups (
     openid TEXT PRIMARY KEY, name TEXT, enabled INTEGER NOT NULL DEFAULT 1,
     msg_count INTEGER NOT NULL DEFAULT 0, first_seen INTEGER, last_seen INTEGER)`,
  `CREATE TABLE IF NOT EXISTS projects (
     id TEXT PRIMARY KEY, name TEXT, description TEXT, owner TEXT, source TEXT,
     created_at INTEGER, updated_at INTEGER, expires_at INTEGER,
     bytes INTEGER NOT NULL DEFAULT 0, hits INTEGER NOT NULL DEFAULT 0,
     data_bytes INTEGER NOT NULL DEFAULT 0, file_count INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS idx_projects_expires ON projects(expires_at)`,
  `CREATE TABLE IF NOT EXISTS files (
     site_id TEXT NOT NULL, path TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0,
     raw_size INTEGER NOT NULL DEFAULT 0, ct TEXT, gz INTEGER NOT NULL DEFAULT 0,
     updated_at INTEGER, PRIMARY KEY (site_id, path))`,
  `CREATE TABLE IF NOT EXISTS sdata (
     site_id TEXT NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL, updated_at INTEGER NOT NULL,
     PRIMARY KEY (site_id, k))`,
  `CREATE TABLE IF NOT EXISTS admins (
     openid TEXT PRIMARY KEY, name TEXT, source TEXT, added_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS mcp (
     id TEXT PRIMARY KEY, name TEXT, url TEXT, transport TEXT, headers TEXT,
     enabled INTEGER NOT NULL DEFAULT 1, tools TEXT, status TEXT,
     last_check INTEGER, note TEXT)`,
  `CREATE TABLE IF NOT EXISTS logins (
     ip TEXT PRIMARY KEY, fails INTEGER NOT NULL DEFAULT 0, until INTEGER, ts INTEGER)`,
  `CREATE TABLE IF NOT EXISTS usage (
     site_id TEXT NOT NULL, day TEXT NOT NULL, writes INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (site_id, day))`,
  `CREATE TABLE IF NOT EXISTS logs (
     id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
     level TEXT NOT NULL, tag TEXT, msg TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts)`,
  `CREATE TABLE IF NOT EXISTS stusage (
     store_id TEXT PRIMARY KEY, bytes INTEGER NOT NULL DEFAULT 0,
     files INTEGER NOT NULL DEFAULT 0, updated_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS skills (
     id TEXT PRIMARY KEY, name TEXT, description TEXT, triggers TEXT,
     content TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
     builtin INTEGER NOT NULL DEFAULT 0, updated_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS exts (
     id TEXT PRIMARY KEY, name TEXT, description TEXT, kind TEXT, config TEXT,
     enabled INTEGER NOT NULL DEFAULT 1, builtin INTEGER NOT NULL DEFAULT 0,
     sort INTEGER NOT NULL DEFAULT 0, updated_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS modules (
     id TEXT PRIMARY KEY, name TEXT, description TEXT, code TEXT NOT NULL,
     params TEXT, call_points TEXT, method TEXT, path TEXT,
     enabled INTEGER NOT NULL DEFAULT 1, timeout_ms INTEGER NOT NULL DEFAULT 5000,
     created_at INTEGER, updated_at INTEGER)`,
];

let ready = null;

export async function ensureSchema(db) {
  if (!db) return false;
  if (ready) return ready;
  ready = (async () => {
    let version = 0;
    try {
      const row = await db.prepare('SELECT v FROM meta WHERE k = ?').bind('schema_version').first();
      version = row ? Number(row.v) : 0;
    } catch {
      version = 0;
    }
    if (version === SCHEMA_VERSION) return true;
    for (const stmt of DDL) {
      try {
        await db.prepare(stmt).run();
      } catch (e) {
        if (!/already exists/i.test(String(e?.message || e))) throw e;
      }
    }
    await db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
      .bind('schema_version', String(SCHEMA_VERSION)).run();
    return true;
  })().catch((e) => {
    ready = null;
    throw e;
  });
  return ready;
}

export async function all(db, sql, ...args) {
  const r = await db.prepare(sql).bind(...args).all();
  return r.results || [];
}

export async function one(db, sql, ...args) {
  return await db.prepare(sql).bind(...args).first();
}

export async function run(db, sql, ...args) {
  return await db.prepare(sql).bind(...args).run();
}

export async function batch(db, stmts) {
  if (!stmts.length) return [];
  return await db.batch(stmts);
}

export function dayKey(ts = Date.now()) {
  const d = new Date(ts + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}
