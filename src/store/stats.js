import { ensureSchema, dayKey, one, run } from './db.js';

export async function bump(env, k, n = 1) {
  await ensureSchema(env.DB);
  await run(env.DB, 'INSERT INTO stats (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = v + excluded.v', k, n);
}

export async function bumpDaily(env, field, n = 1, ts = Date.now()) {
  await ensureSchema(env.DB);
  const day = dayKey(ts);
  const col = ['visits', 'messages', 'projects'].includes(field) ? field : null;
  if (!col) return;
  await run(env.DB,
    `INSERT INTO daily (day, ${col}) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET ${col} = ${col} + excluded.${col}`,
    day, n);
}

export async function touchGroup(env, openid, name) {
  if (!openid) return;
  await ensureSchema(env.DB);
  const now = Date.now();
  await run(env.DB,
    `INSERT INTO groups (openid, name, enabled, msg_count, first_seen, last_seen)
     VALUES (?, ?, 1, 1, ?, ?)
     ON CONFLICT(openid) DO UPDATE SET msg_count = msg_count + 1, last_seen = excluded.last_seen,
       name = COALESCE(excluded.name, groups.name)`,
    openid, name || null, now, now);
}

export async function todayCount(env, field) {
  await ensureSchema(env.DB);
  if (!['visits', 'messages', 'projects'].includes(field)) return 0;
  const r = await one(env.DB, `SELECT ${field} AS n FROM daily WHERE day = ?`, dayKey());
  return Number(r?.n || 0);
}

export async function totals(env) {
  await ensureSchema(env.DB);
  const rows = await env.DB.prepare('SELECT k, v FROM stats').all();
  const out = {};
  for (const r of rows.results || []) out[r.k] = Number(r.v || 0);
  return out;
}

export async function overview(env) {
  await ensureSchema(env.DB);
  const t = await totals(env);
  const day = dayKey();
  const today = await one(env.DB, 'SELECT * FROM daily WHERE day = ?', day);
  const groups = await env.DB.prepare('SELECT * FROM groups ORDER BY last_seen DESC LIMIT 200').all();
  const recent = await env.DB.prepare('SELECT * FROM daily ORDER BY day DESC LIMIT 14').all();
  const projects = await one(env.DB, 'SELECT COUNT(*) AS n FROM projects');
  return {
    totals: {
      visits: t.visits || 0,
      messages: t.messages || 0,
      projects: t.projects_total || 0,
      replies: t.replies || 0,
      tokens: t.tokens || 0,
      tools: t.tools || 0,
      errors: t.errors || 0,
      activeProjects: Number(projects?.n || 0),
    },
    today: {
      visits: Number(today?.visits || 0),
      messages: Number(today?.messages || 0),
      projects: Number(today?.projects || 0),
    },
    groups: (groups.results || []).map((g) => ({
      openid: g.openid,
      name: g.name || g.openid,
      enabled: !!g.enabled,
      msgCount: Number(g.msg_count || 0),
      lastSeen: g.last_seen,
      firstSeen: g.first_seen,
    })),
    daily: (recent.results || []).reverse().map((d) => ({
      day: d.day,
      visits: Number(d.visits || 0),
      messages: Number(d.messages || 0),
      projects: Number(d.projects || 0),
    })),
  };
}
