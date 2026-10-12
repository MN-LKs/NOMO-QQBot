// Durable Object 的 SQLite 表结构。全部用 IF NOT EXISTS,重复执行无害。

export const SCHEMA = [
  // 通用小键值(事件去重、token 缓存、统计)
  `CREATE TABLE IF NOT EXISTS kv (
     k TEXT PRIMARY KEY,
     v TEXT,
     exp INTEGER
   )`,

  // AI 部署的站点
  `CREATE TABLE IF NOT EXISTS sites (
     id          TEXT PRIMARY KEY,
     name        TEXT NOT NULL,
     description TEXT,
     owner       TEXT,
     created_at  INTEGER NOT NULL,
     updated_at  INTEGER NOT NULL,
     expires_at  INTEGER NOT NULL,
     files       TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_sites_updated ON sites(updated_at)`,

  // 会话(群/单聊)
  `CREATE TABLE IF NOT EXISTS conv (
     id         TEXT PRIMARY KEY,
     summary    TEXT,
     updated_at INTEGER NOT NULL
   )`,

  // 会话里的最近消息
  `CREATE TABLE IF NOT EXISTS msg (
     conv_id TEXT NOT NULL,
     seq     INTEGER NOT NULL,
     role    TEXT NOT NULL,
     content TEXT NOT NULL,
     ts      INTEGER NOT NULL,
     PRIMARY KEY (conv_id, seq)
   )`,

  // 待处理任务队列(闹钟驱动)
  `CREATE TABLE IF NOT EXISTS jobs (
     id         TEXT PRIMARY KEY,
     kind       TEXT NOT NULL,
     payload    TEXT NOT NULL,
     status     TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     started_at INTEGER,
     error      TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, created_at)`,

  // 部署站点的内置后端存储(GET/POST ./__data/<key>)
  `CREATE TABLE IF NOT EXISTS sdata (
     site_id    TEXT NOT NULL,
     k          TEXT NOT NULL,
     v          TEXT NOT NULL,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (site_id, k)
   )`,

  // 运行统计
  `CREATE TABLE IF NOT EXISTS stats (
     k TEXT PRIMARY KEY,
     v INTEGER NOT NULL
   )`,
];
