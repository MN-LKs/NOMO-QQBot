import { DEFAULT_SETTINGS, deepMerge, deriveEndpoints, flatten } from '../config.js';
import { maskValue } from '../util/secret.js';
import { ensureSchema, one, run } from './db.js';

let cache = null;
let cacheAt = 0;
// 行的原始字符串缓存:D1 里 settings 是几十行 JSON,
// 每次 getRaw 都全量 JSON.parse + deepMerge + structuredClone 是纯浪费。
let rowCache = null;
let rowCacheAt = 0;
const ROW_TTL = 5000;
const TTL = 5000;

export function invalidate() {
  cache = null;
  cacheAt = 0;
  rowCache = null;
  rowCacheAt = 0;
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

// 只读 settings 行并解析;行级缓存,5 秒内的重复读取不再打 D1 + JSON.parse
async function readRows(env) {
  const now = Date.now();
  if (rowCache && now - rowCacheAt < ROW_TTL) return rowCache;
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
  rowCache = out;
  rowCacheAt = now;
  return out;
}

export async function getRaw(env, { fresh = false } = {}) {
  if (!env?.DB) return structuredClone(DEFAULT_SETTINGS);
  if (fresh) {
    cache = null;
    cacheAt = 0;
    rowCache = null;
    rowCacheAt = 0;
  }
  const now = Date.now();
  if (cache && now - cacheAt < TTL) {
    // 返回副本:调用方(保存/打码/各处)拿到的是可改的独立对象,
    // 就地改缓存会让下一次读取拿到半成品数据。
    return structuredClone(cache);
  }
  const out = await readRows(env);
  migrateLegacy(out);
  cache = deepMerge(structuredClone(DEFAULT_SETTINGS), out);
  cacheAt = Date.now();
  return structuredClone(cache);
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

export async function loadCfg(env) {
  const settings = await getRaw(env);
  return flatten(settings, env);
}

// 只用于「展示」:打码后返回给面板。绝不能把这个结果再写回数据库。
export function maskSecrets(settings) {
  const out = structuredClone(settings);
  if (out.llm?.apiKey) out.llm.apiKey = maskValue(out.llm.apiKey);
  if (out.search?.key) out.search.key = maskValue(out.search.key);
  if (out.extract?.key) out.extract.key = maskValue(out.extract.key);
  if (out.qq?.appSecret) out.qq.appSecret = maskValue(out.qq.appSecret);
  if (Array.isArray(out.storage?.stores)) {
    for (const s of out.storage.stores) {
      if (s && s.accessKey) s.accessKey = maskValue(s.accessKey);
      if (s && s.secretKey) s.secretKey = maskValue(s.secretKey);
    }
  }
  return out;
}
