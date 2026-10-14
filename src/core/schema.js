export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS kv (
     k TEXT PRIMARY KEY,
     v TEXT,
     exp INTEGER
   )`,

  `CREATE TABLE IF NOT EXISTS conv (
     id         TEXT PRIMARY KEY,
     summary    TEXT,
     updated_at INTEGER NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS msg (
     conv_id TEXT NOT NULL,
     seq     INTEGER NOT NULL,
     role    TEXT NOT NULL,
     content TEXT NOT NULL,
     ts      INTEGER NOT NULL,
     PRIMARY KEY (conv_id, seq)
   )`,

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

  `CREATE TABLE IF NOT EXISTS mem (
     conv_id    TEXT NOT NULL,
     k          TEXT NOT NULL,
     v          TEXT NOT NULL,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (conv_id, k)
   )`,

  `CREATE TABLE IF NOT EXISTS fs (
     path       TEXT PRIMARY KEY,
     content    TEXT NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
];
