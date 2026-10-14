import { KV_TOTAL_BYTES } from '../config.js';
import { ensureSchema, all, one, run, dayKey } from './db.js';
import { putFile, delAll, mimeFor } from './kvfile.js';
import { bump, bumpDaily, todayCount } from './stats.js';

export function quotaOf(settings) {
  const total = KV_TOTAL_BYTES;
  const reserve = Math.max(0, Number(settings?.deploy?.reserveBytes) || 0);
  const per = Math.max(1024 * 1024, Number(settings?.deploy?.perProjectBytes) || 1);
  const capacity = Math.max(1, Math.floor((total - reserve) / per));
  const rawMax = Number(settings?.deploy?.maxProjects);
  const want = Math.max(1, Number.isFinite(rawMax) ? Math.floor(rawMax) : 5);
  const maxProjects = Math.min(want, capacity);
  const dynamic = Math.max(0, total - reserve - per * maxProjects);
  return { total, reserve, per, capacity, maxProjects, wanted: want, clamped: want > capacity, dynamic };
}

export async function totalUsed(env) {
  await ensureSchema(env.DB);
  const r = await one(env.DB, 'SELECT COALESCE(SUM(bytes),0) AS s FROM projects');
  return Number(r?.s || 0);
}

export async function listProjects(env, { includeExpired = false } = {}) {
  await ensureSchema(env.DB);
  const now = Date.now();
  const sql = includeExpired
    ? 'SELECT * FROM projects ORDER BY created_at DESC'
    : 'SELECT * FROM projects WHERE expires_at > ? ORDER BY created_at DESC';
  const r = includeExpired
    ? await env.DB.prepare(sql).all()
    : await env.DB.prepare(sql).bind(now).all();
  return r.results || [];
}

export async function getProject(env, id) {
  await ensureSchema(env.DB);
  return await one(env.DB, 'SELECT * FROM projects WHERE id = ?', String(id || ''));
}

export async function findByName(env, name) {
  await ensureSchema(env.DB);
  const rows = await all(env.DB, 'SELECT * FROM projects WHERE name = ? ORDER BY created_at DESC', String(name || ''));
  return rows[0] || null;
}

export async function listFiles(env, id) {
  await ensureSchema(env.DB);
  return await all(env.DB, 'SELECT path, size, raw_size, ct, gz, updated_at FROM files WHERE site_id = ? ORDER BY path', String(id || ''));
}

export async function usage(env, id) {
  await ensureSchema(env.DB);
  const f = await one(env.DB,
    'SELECT COALESCE(SUM(size),0) AS s, COALESCE(SUM(raw_size),0) AS r, COUNT(*) AS n FROM files WHERE site_id = ?', String(id || ''));
  const d = await one(env.DB,
    'SELECT COALESCE(SUM(LENGTH(v)),0) AS s, COUNT(*) AS n FROM sdata WHERE site_id = ?', String(id || ''));
  return {
    bytes: Number(f?.s || 0),
    rawBytes: Number(f?.r || 0),
    files: Number(f?.n || 0),
    dataBytes: Number(d?.s || 0),
    dataKeys: Number(d?.n || 0),
  };
}

export async function limitsFor(env, settings, projectId = null) {
  const q = quotaOf(settings);
  const used = await listProjects(env, { includeExpired: false });
  const rows = await all(env.DB, 'SELECT id, bytes, hits, created_at FROM projects');
  const extra = rows.reduce((s, r) => s + Math.max(0, Number(r.bytes || 0) - q.per), 0);
  const avail = Math.max(0, q.dynamic - extra);
  const weights = rows.map((r) => ({
    id: r.id,
    w: 1 + Math.min(20, Number(r.hits || 0) / 50) + (Date.now() - Number(r.created_at || 0) < 86400000 ? 2 : 0),
  }));
  const sum = weights.reduce((s, x) => s + x.w, 0) || 1;
  const mine = weights.find((x) => x.id === projectId);
  const share = mine ? (avail * mine.w) / sum : 0;
  return {
    quota: q,
    activeCount: used.length,
    dynamicAvail: avail,
    limit: q.per + share,
    base: q.per,
    share,
  };
}

export async function writeFiles(env, id, files, limitBytes) {
  const written = [];
  let total = 0;
  for (const f of files) {
    const path = String(f.path || '').replace(/^\/+/, '').replace(/\.\./g, '');
    if (!path) continue;
    const ct = f.ct || mimeFor(path);
    const r = await putFile(env, id, path, f.content, ct);
    total += r.size;
    if (limitBytes && total > limitBytes) {
      return { error: `超过这个项目可用的存储额度(${Math.round(limitBytes / 1024 / 1024)} MB)`, written };
    }
    await run(env.DB,
      `INSERT INTO files (site_id, path, size, raw_size, ct, gz, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(site_id, path) DO UPDATE SET size = excluded.size, raw_size = excluded.raw_size,
         ct = excluded.ct, gz = excluded.gz, updated_at = excluded.updated_at`,
      id, path, r.size, r.rawSize, r.ct, r.gz, Date.now());
    written.push({ path, size: r.size, rawSize: r.rawSize, ct: r.ct });
  }
  return { written, total };
}

export async function recalc(env, id) {
  const u = await usage(env, id);
  await run(env.DB, 'UPDATE projects SET bytes = ?, file_count = ?, data_bytes = ?, updated_at = ? WHERE id = ?',
    u.bytes + u.dataBytes, u.files, u.dataBytes, Date.now(), id);
  return u;
}

export async function createProject(env, settings, { id, name, description, owner, source = 'panel', files = [], ttlSeconds }) {
  await ensureSchema(env.DB);
  const perDay = Number(settings?.deploy?.maxPerDay) || 50;
  const usedToday = await todayCount(env, 'projects');
  if (usedToday >= perDay) {
    return { error: `今天已经部署了 ${usedToday} 次,达到上限(${perDay} 次/天),明天再来吧` };
  }
  const lim = await limitsFor(env, settings, null);
  const active = await listProjects(env);
  if (active.length >= lim.quota.maxProjects) {
    return { error: `同时可部署的项目已达上限(${lim.quota.maxProjects} 个),先删掉一个再试` };
  }
  const ttl = Number(ttlSeconds) || Number(settings?.deploy?.ttlSeconds) || 600;
  const now = Date.now();
  await run(env.DB,
    `INSERT INTO projects (id, name, description, owner, source, created_at, updated_at, expires_at, bytes, hits, data_bytes, file_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0)`,
    id, name || '未命名项目', description || '', owner || '', source, now, now, now + ttl * 1000);
  if (files.length) {
    const r = await writeFiles(env, id, files, lim.quota.per);
    if (r.error) {
      await removeProject(env, id);
      return { error: r.error };
    }
  }
  await recalc(env, id);
  await bumpDaily(env, 'projects', 1).catch(() => null);
  await bump(env, 'projects_total', 1).catch(() => null);
  return { id };
}

export async function extendProject(env, id, seconds) {
  const p = await getProject(env, id);
  if (!p) return { error: '项目不存在' };
  const base = Math.max(Number(p.expires_at || 0), Date.now());
  const next = base + Number(seconds || 600) * 1000;
  await run(env.DB, 'UPDATE projects SET expires_at = ?, updated_at = ? WHERE id = ?', next, Date.now(), id);
  return { expiresAt: next };
}

export async function removeProject(env, id) {
  const p = await getProject(env, id);
  if (!p) return { error: '项目不存在' };
  try {
    await delAll(env, id);
  } catch (e) {
    console.warn('[projects] 清理 KV 失败', e?.message || e);
  }
  await run(env.DB, 'DELETE FROM files WHERE site_id = ?', id);
  await run(env.DB, 'DELETE FROM sdata WHERE site_id = ?', id);
  await run(env.DB, 'DELETE FROM usage WHERE site_id = ?', id);
  await run(env.DB, 'DELETE FROM projects WHERE id = ?', id);
  return { ok: true, name: p.name };
}

export async function purgeExpired(env) {
  await ensureSchema(env.DB);
  const now = Date.now();
  const rows = await all(env.DB, 'SELECT id, name FROM projects WHERE expires_at <= ? LIMIT 20', now);
  const gone = [];
  for (const r of rows) {
    await removeProject(env, r.id);
    gone.push(r.name || r.id);
  }
  return gone;
}

export async function bumpHits(env, id, n = 1) {
  await run(env.DB, 'UPDATE projects SET hits = hits + ? WHERE id = ?', n, id);
}

export async function dataGet(env, id, key) {
  const r = await one(env.DB, 'SELECT v FROM sdata WHERE site_id = ? AND k = ?', String(id), String(key));
  return r ? r.v : null;
}

export async function dataSet(env, id, key, value, quotaBytes) {
  const cur = await usage(env, id);
  const size = String(value).length;
  const old = await dataGet(env, id, key);
  const delta = size - (old ? String(old).length : 0);
  if (quotaBytes && cur.dataBytes + delta > quotaBytes) {
    return { error: `这个项目的数据库配额已满(${Math.round(quotaBytes / 1024)} KB)` };
  }
  await run(env.DB,
    'INSERT INTO sdata (site_id, k, v, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(site_id, k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at',
    String(id), String(key), String(value), Date.now());
  await run(env.DB, 'UPDATE projects SET data_bytes = data_bytes + ? WHERE id = ?', delta, String(id));
  return { ok: true, bytes: size };
}
