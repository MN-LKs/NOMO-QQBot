// 预制后端JS模块:管理员在面板里写好的后端 JS,两个用途 ——
//   callPoints 含 agent:变成 Agent 工具(模型可以直接调用)
//   callPoints 含 site :部署出去的网页可以 fetch("/api/<模块id>") 调用
// 代码由 jsmini 解释器执行(Workers 禁 eval,解释器就是沙盒)。

import { ensureSchema } from '../store/db.js';

export function parseCallPoints(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map((x) => String(x).trim()).filter(Boolean);
  return String(raw).split(/[,,\s]+/).map((x) => x.trim()).filter((x) => x === 'agent' || x === 'site');
}

export function normalizeModule(r) {
  let params = {};
  try {
    params = r.params ? JSON.parse(r.params) : {};
  } catch {
    params = {};
  }
  return {
    id: r.id,
    name: r.name || r.id,
    description: r.description || '',
    code: r.code || '',
    params: params && typeof params === 'object' ? params : {},
    callPoints: parseCallPoints(r.call_points),
    method: String(r.method || 'ANY').toUpperCase(),
    path: String(r.path || ''),
    enabled: !!r.enabled,
    timeoutMs: Number(r.timeout_ms) || 5000,
    createdAt: Number(r.created_at || 0),
    updatedAt: Number(r.updated_at || 0),
  };
}

export async function listModules(env, { enabledOnly = false } = {}) {
  await ensureSchema(env.DB);
  const rows = await env.DB.prepare('SELECT * FROM modules ORDER BY updated_at DESC').all();
  const out = (rows.results || []).map(normalizeModule);
  return enabledOnly ? out.filter((m) => m.enabled) : out;
}

export async function getModule(env, id) {
  await ensureSchema(env.DB);
  const r = await env.DB.prepare('SELECT * FROM modules WHERE id = ?').bind(String(id)).first();
  return r ? normalizeModule(r) : null;
}

export async function saveModule(env, m) {
  await ensureSchema(env.DB);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO modules (id, name, description, code, params, call_points, method, path, enabled, timeout_ms, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, code = excluded.code,
       params = excluded.params, call_points = excluded.call_points, method = excluded.method, path = excluded.path,
       enabled = excluded.enabled, timeout_ms = excluded.timeout_ms, updated_at = excluded.updated_at`,
  ).bind(
    m.id, m.name, m.description, m.code,
    JSON.stringify(m.params || {}), (m.callPoints || []).join(','),
    m.method || 'ANY', m.path || '', m.enabled ? 1 : 0,
    Math.max(500, Math.min(30000, Number(m.timeoutMs) || 5000)), m.createdAt || now, now,
  ).run();
  return m;
}

export async function removeModule(env, id) {
  await ensureSchema(env.DB);
  await env.DB.prepare('DELETE FROM modules WHERE id = ?').bind(String(id)).run();
}

// 给 Agent 的模块清单(调用点含 agent)
export function agentModules(modules) {
  return (modules || []).filter((m) => m.enabled && m.callPoints.includes('agent'));
}

// 给站点后端的模块清单(调用点含 site)
export function siteModules(modules) {
  return (modules || []).filter((m) => m.enabled && m.callPoints.includes('site'));
}
