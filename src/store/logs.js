import { ensureSchema, dayKey } from './db.js';

export async function write(env, level, tag, msg) {
  const line = typeof msg === 'string' ? msg : JSON.stringify(msg);
  if (level === 'error') console.error(`[${tag}] ${line}`);
  else if (level === 'warn') console.warn(`[${tag}] ${line}`);
  else console.log(`[${tag}] ${line}`);
  if (!env?.DB) return;
  try {
    await ensureSchema(env.DB);
    await env.DB.prepare('INSERT INTO logs (ts, level, tag, msg) VALUES (?, ?, ?, ?)')
      .bind(Date.now(), level, String(tag || ''), line.slice(0, 4000)).run();
  } catch (e) {
    console.warn('[logs] 写入失败', e?.message || e);
  }
}

export const logWrite = write;

export async function list(env, { level = '', limit = 200, before = 0 } = {}) {
  await ensureSchema(env.DB);
  const n = Math.max(1, Math.min(1000, Number(limit) || 200));
  const args = [];
  let sql = 'SELECT id, ts, level, tag, msg FROM logs';
  const where = [];
  if (level) {
    where.push('level = ?');
    args.push(level);
  }
  if (before) {
    where.push('id < ?');
    args.push(Number(before));
  }
  if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
  sql += ' ORDER BY id DESC LIMIT ?';
  args.push(n);
  const r = await env.DB.prepare(sql).bind(...args).all();
  return (r.results || []).reverse();
}

export async function count(env) {
  await ensureSchema(env.DB);
  const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM logs').first();
  return Number(r?.n || 0);
}

export async function clear(env) {
  await ensureSchema(env.DB);
  await env.DB.prepare('DELETE FROM logs').run();
}

export async function cleanup(env, { retentionDays = 7, maxRows = 8000 } = {}) {
  await ensureSchema(env.DB);
  const cut = Date.now() - retentionDays * 86400000;
  await env.DB.prepare('DELETE FROM logs WHERE ts < ?').bind(cut).run();
  const n = await count(env);
  if (n > maxRows) {
    await env.DB.prepare('DELETE FROM logs WHERE id IN (SELECT id FROM logs ORDER BY id ASC LIMIT ?)')
      .bind(n - maxRows).run();
  }
  return count(env);
}
