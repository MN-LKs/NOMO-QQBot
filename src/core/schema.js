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

  `CREATE TABLE IF NOT EXISTS gmsg (
     id         TEXT PRIMARY KEY,
     group_id   TEXT NOT NULL,
     user_id    TEXT,
     user_name  TEXT,
     content    TEXT NOT NULL,
     ts         INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_gmsg_group ON gmsg(group_id, ts)`,

  `CREATE TABLE IF NOT EXISTS pending (
     token       TEXT PRIMARY KEY,
     payload     TEXT NOT NULL,
     arch        TEXT NOT NULL DEFAULT 'html',
     conv_id     TEXT,
     target_id   TEXT,
     scene       TEXT,
     msg_id      TEXT,
     card_msg_id TEXT,
     notify_ts   INTEGER,
     notified    INTEGER NOT NULL DEFAULT 0,
     created_at  INTEGER NOT NULL,
     expires_at  INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_pending_exp ON pending(expires_at)`,
];

// DO 的 SQLite 用 CREATE TABLE IF NOT EXISTS,老库不会自动长出新列。
// 部署确认卡片后来加了 arch / card_msg_id / notify_ts / notified,
// 这里逐个补列,加过了就跳过(duplicate column name 直接忽略)。
export const ALTERS = [
  `ALTER TABLE pending ADD COLUMN arch TEXT NOT NULL DEFAULT 'html'`,
  `ALTER TABLE pending ADD COLUMN card_msg_id TEXT`,
  `ALTER TABLE pending ADD COLUMN notify_ts INTEGER`,
  `ALTER TABLE pending ADD COLUMN notified INTEGER NOT NULL DEFAULT 0`,
];
