// 在 Node 里模拟 Cloudflare 的最小运行环境,好让 Worker 和 Durable Object
// 能脱离 workerd 直接跑测试。
//
// 为什么需要它?本沙盒是 Android/proot,workerd 的 tcmalloc 起不来
// (MmapAligned 要求 48 位地址空间)。这个 harness 用 node:sqlite 顶上 DO 的 SQLite,
// 其余 API 面(shadow stub.fetch / ctx.storage / waitUntil)按官方语义实现。

import { DatabaseSync } from 'node:sqlite';
import { BotCore } from '../src/core/do.js';

class FakeCursor {
  constructor(rows) {
    this.rows = rows;
  }
  toArray() { return this.rows; }
  one() { return this.rows[0] ?? null; }
  raw() { return this.rows.map((r) => Object.values(r)); }
  [Symbol.iterator]() { return this.rows[Symbol.iterator](); }
  get rowsRead() { return this.rows.length; }
  get rowsWritten() { return 0; }
  get columnNames() { return this.rows[0] ? Object.keys(this.rows[0]) : []; }
}

class FakeSql {
  constructor(db) { this.db = db; }
  exec(query, ...params) {
    const head = query.trim().slice(0, 6).toUpperCase();
    const isRead = head === 'SELECT' || head.startsWith('WITH') || head.startsWith('PRAGMA');
    const stmt = this.db.prepare(query);
    if (isRead) {
      const rows = stmt.all(...params).map((r) => ({ ...r }));
      return new FakeCursor(rows);
    }
    stmt.run(...params);
    return new FakeCursor([]);
  }
}

class FakeStorage {
  constructor(db) {
    this.db = db;
    this.sql = new FakeSql(db);
    this.alarmTs = null;
  }
  async setAlarm(ts) { this.alarmTs = Number(ts); }
  async getAlarm() { return this.alarmTs; }
  async deleteAlarm() { this.alarmTs = null; }
  async put() { throw new Error('harness: 未实现 KV 存储,本项目只用 SQLite'); }
  async get() { return undefined; }
}

/** 一个进程内的 DO 命名空间:同一 name 永远拿到同一个实例 */
export class FakeDONamespace {
  constructor(env) {
    this.env = env;
    this.instances = new Map();
    this.log = [];
  }
  idFromName(name) { return `do:${name}`; }
  idFromString(s) { return s; }
  get(id) {
    if (!this.instances.has(id)) {
      const ctx = {
        storage: new FakeStorage(new DatabaseSync(':memory:')),
        blockConcurrencyWhile: async (fn) => fn(),
        waitUntil: () => {},
      };
      const obj = new BotCore(ctx, this.env);
      obj.__ctx = ctx;
      this.instances.set(id, obj);
    }
    const obj = this.instances.get(id);
    return {
      fetch: (input, init) => {
        const req = input instanceof Request ? input : new Request(input, init);
        return obj.fetch(req);
      },
    };
  }
  /** 取出那个唯一的 BotCore 实例 */
  core(name = 'core') { return this.instances.get(`do:${name}`); }
}

/**
 * 造一个假的 env。
 * @param {object} vars 环境变量(等价于 wrangler [vars])
 */
export function makeEnv(vars = {}) {
  const env = { ...vars };
  env.BOT_CORE = new FakeDONamespace(env);
  return env;
}

/**
 * 驱动闹钟。真实运行时是 Cloudflare 帮我们调度,这里手动跑。
 * 返回一个 stop()。
 */
export function startAlarmRunner(env, { intervalMs = 20 } = {}) {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    const obj = env.BOT_CORE.core('core');
    if (!obj) return;
    const ctx = obj.__ctx;
    const ts = ctx.storage.alarmTs;
    if (ts === null || ts > Date.now()) return;
    ctx.storage.alarmTs = null;
    running = true;
    try {
      await obj.alarm();
    } catch (e) {
      console.error('[harness] 闹钟异常', e);
    } finally {
      running = false;
    }
  }, intervalMs);
  return { stop: () => clearInterval(timer) };
}

/** 造一个假的 ExecutionContext */
export function makeCtx() {
  const pending = [];
  return {
    pending,
    waitUntil(p) { pending.push(p); },
    passThroughOnException() {},
    async drain() { await Promise.allSettled(pending); },
  };
}
