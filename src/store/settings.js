import { DEFAULT_SETTINGS, deepMerge, deriveEndpoints, flatten } from '../config.js';
import { ensureSchema, one, run } from './db.js';

let cache = null;
let cacheAt = 0;
const TTL = 5000;

export function invalidate() {
  cache = null;
  cacheAt = 0;
}

// 旧版本(v3)把搜索和网页读取拆成 search.url / extract.url 两套配置。
// v4 合并成一个「带 /v1 的 url」,这里把旧数据搬过去,保证升级后不用重新填。
function migrateLegacy(out) {
  const search = out.search && typeof out.search === 'object' ? out.search : null;
  const extract = out.extract && typeof out.extract === 'object' ? out.extract : null;
  if (search && search.url && !search.baseUrl) {
    const ep = deriveEndpoints(search.url, search.searchPath, search.readerPath);
    search.baseUrl = ep.base;
  }
  if (!out.search && extract && extract.url) {
    out.search = {};
  }
  if (extract && extract.url && out.search && !out.search.baseUrl) {
    const ep = deriveEndpoints(extract.url, out.search.searchPath, out.search.readerPath);
    out.search.baseUrl = ep.base;
  }
  if (out.search && !out.search.key && extract && extract.key) {
    out.search.key = extract.key;
  }
  return out;
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
  migrateLegacy(out);
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
  if (out.extract?.key) out.extract.key = mask(out.extract.key);
  if (out.qq?.appSecret) out.qq.appSecret = mask(out.qq.appSecret);
  if (Array.isArray(out.storage?.stores)) {
    for (const s of out.storage.stores) {
      if (s && s.secretKey) s.secretKey = mask(s.secretKey);
    }
  }
  return out;
}
