import { DEFAULT_SETTINGS, deepMerge, flatten } from '../config.js';
import { ensureSchema, one, run } from './db.js';

let cache = null;
let cacheAt = 0;
const TTL = 5000;

export function invalidate() {
  cache = null;
  cacheAt = 0;
}

export async function getRaw(env, { fresh = false } = {}) {
  if (!env?.DB) return { ...DEFAULT_SETTINGS };
  if (!fresh && cache && Date.now() - cacheAt < TTL) return cache;
  await ensureSchema(env.DB);
  const rows = await env.DB.prepare('SELECT k, v FROM settings').all();
  const out = {};
  for (const r of rows.results || []) {
    try {
      out[r.k] = JSON.parse(r.v);
    } catch {
      out[r.k] = null;
    }
  }
  cache = deepMerge(structuredClone(DEFAULT_SETTINGS), out);
  cacheAt = Date.now();
  return cache;
}

export async function savePatch(env, patch) {
  const cur = await getRaw(env, { fresh: true });
  const next = deepMerge(cur, patch || {});
  const stmts = [];
  for (const [k, v] of Object.entries(patch || {})) {
    if (!(k in cur) && !(k in DEFAULT_SETTINGS)) continue;
    stmts.push(env.DB.prepare('INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
      .bind(k, JSON.stringify(next[k])));
  }
  if (stmts.length) await env.DB.batch(stmts);
  invalidate();
  return next;
}

export async function setKey(env, key, value) {
  await run(env.DB, 'INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
    key, JSON.stringify(value));
  invalidate();
}

export async function loadCfg(env) {
  const settings = await getRaw(env);
  return flatten(settings, env);
}

export function maskSecrets(settings) {
  const out = structuredClone(settings);
  const mask = (v) => {
    const s = String(v || '');
    if (!s) return '';
    if (s.length <= 8) return '********';
    return `${s.slice(0, 4)}********${s.slice(-4)}`;
  };
  if (out.llm?.apiKey) out.llm.apiKey = mask(out.llm.apiKey);
  if (out.search?.key) out.search.key = mask(out.search.key);
  if (out.qq?.appSecret) out.qq.appSecret = mask(out.qq.appSecret);
  return out;
}
