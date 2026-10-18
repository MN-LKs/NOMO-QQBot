// 统一存储层:把部署的文件写到「当前主存储」,并支持 KV 缓存/备份与外部 S3。
//
// 三个来源:
//   r2   —— 绑定了 env.R2 就自动出现在存储列表里(默认优先级 100,主存储)
//   kv   —— 绑定了 env.STORE 就自动出现(默认优先级 10,备用/缓存)
//   s3   —— 面板里手动添加的 S3 兼容存储(Filebase / Upstash / MinIO / R2 S3 API 等)
//
// 规则:写 -> 按优先级选第一个「启用 + 可用 + 还有空间」的存储;
//       KV 作为缓存开关打开且主存储不是 KV 时,顺带写一份到 KV(读取时兜底);
//       读 -> 主存储优先,失败或没有就依次找其它存储。

import { getRaw, savePatch } from './settings.js';
import { ensureSchema, one, run } from './db.js';
import { S3Client } from './s3.js';

export const R2_DEFAULT_BYTES = 10 * 1024 ** 3;
export const KV_DEFAULT_BYTES = 1024 ** 3;
export const S3_DEFAULT_BYTES = 5 * 1024 ** 3;

export function autoEntries(env) {
  const list = [];
  if (env?.R2) list.push({ id: 'r2', kind: 'r2', name: 'R2 存储桶', builtin: true, enabled: true, priority: 100, maxBytes: R2_DEFAULT_BYTES });
  if (env?.STORE) list.push({ id: 'kv', kind: 'kv', name: 'KV 命名空间', builtin: true, enabled: true, priority: 10, maxBytes: KV_DEFAULT_BYTES });
  return list;
}

function kindDefaults(kind) {
  if (kind === 'r2') return { id: 'r2', kind: 'r2', name: 'R2 存储桶', builtin: true, enabled: true, priority: 100, maxBytes: R2_DEFAULT_BYTES };
  if (kind === 'kv') return { id: 'kv', kind: 'kv', name: 'KV 命名空间', builtin: true, enabled: true, priority: 10, maxBytes: KV_DEFAULT_BYTES };
  return { kind: 's3', enabled: true, priority: 50, maxBytes: S3_DEFAULT_BYTES };
}

// 把「配置里的存储」和「实际绑定的存储」合并成一份权威列表。
// 注意:配置里有、但绑定已断开的存储也会出现在列表里(标为不可用),好让面板弹警告。
export function resolveStores(settings, env) {
  const cfgStores = Array.isArray(settings?.storage?.stores) ? settings.storage.stores : [];
  const out = [];
  for (const auto of autoEntries(env)) {
    const saved = cfgStores.find((s) => s.id === auto.id) || {};
    out.push({
      ...auto,
      enabled: saved.enabled !== false,
      priority: Number.isFinite(Number(saved.priority)) ? Number(saved.priority) : auto.priority,
      maxBytes: Number(saved.maxBytes) > 0 ? Number(saved.maxBytes) : auto.maxBytes,
      name: saved.name || auto.name,
    });
  }
  for (const s of cfgStores) {
    if (!s || typeof s !== 'object') continue;
    if (s.id === 'r2' || s.id === 'kv') {
      if (!out.some((x) => x.id === s.id)) {
        // 曾经配置过、但绑定没了:保留在列表里,标成不可用
        out.push({
          ...kindDefaults(s.kind === 'kv' ? 'kv' : 'r2'),
          ...s,
          enabled: s.enabled !== false,
          priority: Number(s.priority) || 0,
          maxBytes: Number(s.maxBytes) > 0 ? Number(s.maxBytes) : R2_DEFAULT_BYTES,
        });
      }
      continue;
    }
    out.push({
      ...kindDefaults('s3'),
      ...s,
      enabled: s.enabled !== false,
      priority: Number.isFinite(Number(s.priority)) ? Number(s.priority) : 50,
      maxBytes: Number(s.maxBytes) > 0 ? Number(s.maxBytes) : S3_DEFAULT_BYTES,
    });
  }
  out.sort((a, b) => b.priority - a.priority);
  return out;
}

export function availability(env, s) {
  if (!s) return { ok: false, reason: '存储不存在' };
  if (s.kind === 'r2') return env?.R2 ? { ok: true } : { ok: false, reason: 'R2 绑定缺失(变量名需为 R2)' };
  if (s.kind === 'kv') return env?.STORE ? { ok: true } : { ok: false, reason: 'KV 绑定缺失(变量名需为 STORE)' };
  if (s.kind === 's3') {
    const ok = !!(s.endpoint && s.bucket && s.accessKey && s.secretKey);
    return ok ? { ok: true } : { ok: false, reason: 'S3 配置不完整' };
  }
  return { ok: false, reason: `未知存储类型 ${s.kind}` };
}

export function getAdapter(env, s) {
  if (s.kind === 'r2') return r2Adapter(env);
  if (s.kind === 'kv') return kvAdapter(env);
  if (s.kind === 's3') return s3Adapter(s);
  throw new Error(`未知存储类型 ${s.kind}`);
}

function kvAdapter(env) {
  return {
    kind: 'kv',
    async put(key, bytes) {
      await env.STORE.put(key, bytes, { metadata: { s: bytes.byteLength ?? bytes.length } });
    },
    async get(key) {
      const r = await env.STORE.get(key, 'arrayBuffer');
      return r ? new Uint8Array(r) : null;
    },
    async head(key) {
      const r = await env.STORE.list({ prefix: key, limit: 1 });
      const k = (r.keys || []).find((x) => x.name === key);
      return k ? Number(k.metadata?.s || 0) : null;
    },
    async delete(key) {
      await env.STORE.delete(key);
    },
    async list({ prefix = '', cursor, limit = 1000 }) {
      const r = await env.STORE.list({ prefix, cursor, limit });
      return {
        keys: (r.keys || []).map((k) => ({ name: k.name, size: Number(k.metadata?.s || 0) })),
        cursor: r.list_complete ? null : r.cursor,
        complete: !!r.list_complete,
      };
    },
  };
}

function r2Adapter(env) {
  return {
    kind: 'r2',
    async put(key, bytes, contentType) {
      await env.R2.put(key, bytes, contentType ? { httpMetadata: { contentType } } : undefined);
    },
    async get(key) {
      const o = await env.R2.get(key);
      if (!o) return null;
      return new Uint8Array(await o.arrayBuffer());
    },
    async head(key) {
      const o = await env.R2.head(key);
      return o ? Number(o.size || 0) : null;
    },
    async delete(key) {
      await env.R2.delete(key);
    },
    async list({ prefix = '', cursor, limit = 1000 }) {
      const r = await env.R2.list({ prefix, cursor, limit });
      return {
        keys: (r.objects || []).map((o) => ({ name: o.key, size: Number(o.size || 0) })),
        cursor: r.truncated ? r.cursor : null,
        complete: !r.truncated,
      };
    },
  };
}

function s3Adapter(s) {
  const c = new S3Client(s);
  return {
    kind: 's3',
    async put(key, bytes, contentType) {
      await c.put(key, bytes, contentType);
    },
    async get(key) {
      return await c.get(key);
    },
    async head(key) {
      return await c.head(key);
    },
    async delete(key) {
      await c.delete(key);
    },
    async list(opts) {
      return await c.list(opts);
    },
  };
}

// ---------------------------------------------------------------------------
// 用量统计(stusage 表):写入/删除时增量维护,面板里可以「重新统计」全量校准
// ---------------------------------------------------------------------------

export async function usageMap(env) {
  if (!env?.DB) return {};
  await ensureSchema(env.DB);
  const rows = await env.DB.prepare('SELECT store_id, bytes, files FROM stusage').all();
  const out = {};
  for (const r of rows.results || []) out[r.store_id] = { bytes: Number(r.bytes || 0), files: Number(r.files || 0) };
  return out;
}

export async function addUsage(env, storeId, bytesDelta, filesDelta = 0) {
  if (!env?.DB) return;
  try {
    await ensureSchema(env.DB);
    await run(env.DB,
      `INSERT INTO stusage (store_id, bytes, files, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(store_id) DO UPDATE SET bytes = MAX(0, bytes + excluded.bytes), files = MAX(0, files + excluded.files), updated_at = excluded.updated_at`,
      storeId, Math.round(bytesDelta), Math.round(filesDelta), Date.now());
  } catch {
    /* 统计失败不影响主流程 */
  }
}

export async function scanStore(env, store, { prefix = '' } = {}) {
  const av = availability(env, store);
  if (!av.ok) return { error: av.reason };
  const ad = getAdapter(env, store);
  let cursor = undefined;
  let bytes = 0;
  let files = 0;
  for (let i = 0; i < 50; i++) {
    const page = await ad.list({ prefix, cursor, limit: 1000 });
    for (const k of page.keys) {
      bytes += Number(k.size || 0);
      files++;
    }
    if (page.complete || !page.cursor) break;
    cursor = page.cursor;
  }
  await addUsageRaw(env, store.id, bytes, files);
  return { bytes, files, providerMaxBytes: providerMaxBytes(store) };
}

async function addUsageRaw(env, storeId, bytes, files) {
  if (!env?.DB) return;
  await ensureSchema(env.DB);
  await run(env.DB,
    `INSERT INTO stusage (store_id, bytes, files, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(store_id) DO UPDATE SET bytes = excluded.bytes, files = excluded.files, updated_at = excluded.updated_at`,
    storeId, bytes, files, Date.now());
}

// ---------------------------------------------------------------------------
// 选存储 + 读写
// ---------------------------------------------------------------------------

async function pickWriteStore(env, settings, size) {
  const stores = resolveStores(settings, env);
  const usage = await usageMap(env);
  for (const s of stores) {
    if (!s.enabled) continue;
    if (!availability(env, s).ok) continue;
    const used = usage[s.id]?.bytes || 0;
    if (s.maxBytes > 0 && used + size > s.maxBytes) continue;
    return s;
  }
  return null;
}

export async function putObject(env, key, bytes, { contentType = '' } = {}) {
  const settings = await getRaw(env);
  const size = bytes.byteLength ?? bytes.length ?? 0;
  const chosen = await pickWriteStore(env, settings, size);
  if (!chosen) throw new Error('没有可用的存储空间(检查 KV/R2 绑定,或各存储桶的容量上限)');
  const ad = getAdapter(env, chosen);
  await ad.put(key, bytes, contentType);
  await addUsage(env, chosen.id, size, 1);
  const mirrors = [];
  const cacheKV = settings.storage?.cacheKV !== false;
  if (cacheKV && chosen.kind !== 'kv' && env?.STORE) {
    try {
      await kvAdapter(env).put(key, bytes, contentType);
      await addUsage(env, 'kv', size, 1);
      mirrors.push('kv');
    } catch {
      /* 缓存失败不挡主流程 */
    }
  }
  return { storeId: chosen.id, size, mirrors };
}

export async function getObject(env, key) {
  const settings = await getRaw(env);
  const stores = resolveStores(settings, env);
  for (const s of stores) {
    if (!s.enabled || !availability(env, s).ok) continue;
    try {
      const bytes = await getAdapter(env, s).get(key);
      if (bytes) return { bytes, storeId: s.id };
    } catch {
      /* 读不到就试下一个 */
    }
  }
  return null;
}

export async function deleteObject(env, key) {
  const settings = await getRaw(env);
  const stores = resolveStores(settings, env);
  const removed = [];
  for (const s of stores) {
    if (!availability(env, s).ok) continue;
    try {
      const ad = getAdapter(env, s);
      const size = await ad.head(key);
      if (size === null) continue;
      await ad.delete(key);
      await addUsage(env, s.id, -size, -1);
      removed.push(s.id);
    } catch {
      /* ignore */
    }
  }
  return removed;
}

export async function deletePrefix(env, prefix) {
  const settings = await getRaw(env);
  const stores = resolveStores(settings, env);
  let total = 0;
  for (const s of stores) {
    if (!availability(env, s).ok) continue;
    try {
      const ad = getAdapter(env, s);
      let cursor = undefined;
      let sum = 0;
      let count = 0;
      for (let i = 0; i < 30; i++) {
        const page = await ad.list({ prefix, cursor, limit: 1000 });
        for (const k of page.keys) {
          await ad.delete(k.name);
          sum += Number(k.size || 0);
          count++;
        }
        if (page.complete || !page.cursor) break;
        cursor = page.cursor;
      }
      if (count) {
        await addUsage(env, s.id, -sum, -count);
        total += count;
      }
    } catch {
      /* ignore */
    }
  }
  return total;
}

/**
 * 服务商容量上限的启发式识别。
 * S3 协议本身不返回配额,所以只能按端点/类型给一个「服务商上限」参考值;
 * 用户自己填的 maxBytes 仍然是实际写入上限。
 */
export function providerMaxBytes(store) {
  const kind = String(store?.kind || '');
  const ep = String(store?.endpoint || '').toLowerCase();
  if (kind === 'kv') return KV_DEFAULT_BYTES;
  if (kind === 'r2' || ep.includes('r2.cloudflarestorage.com')) return R2_DEFAULT_BYTES;
  if (ep.includes('filebase')) return 5 * 1024 ** 3;
  if (ep.includes('backblaze') || ep.includes('b2')) return 10 * 1024 ** 3;
  if (ep.includes('minio')) return 0;
  return S3_DEFAULT_BYTES;
}

function findStore(settings, env, storeId) {
  const s = resolveStores(settings, env).find((x) => x.id === String(storeId || ''));
  if (!s) return { error: '存储不存在' };
  const av = availability(env, s);
  if (!av.ok) return { error: av.reason };
  return { store: s, adapter: getAdapter(env, s) };
}

function safeKey(key) {
  const k = String(key || '').trim();
  if (!k || k.length > 512) return '';
  if (/[\u0000-\u001f]/.test(k)) return '';
  return k;
}

export async function storeDetail(env, storeId, { prefix = '', cursor, limit = 100 } = {}) {
  const settings = await getRaw(env, { fresh: true });
  const found = findStore(settings, env, storeId);
  if (found.error) return { error: found.error };
  const { store, adapter } = found;
  const page = await adapter.list({ prefix, cursor, limit });
  const usage = await usageMap(env);
  const u = usage[store.id] || { bytes: 0, files: 0 };
  return {
    store: {
      id: store.id,
      kind: store.kind,
      name: store.name || store.id,
      builtin: !!store.builtin,
      enabled: !!store.enabled,
      priority: Number(store.priority) || 0,
      maxBytes: Number(store.maxBytes) || 0,
      providerMaxBytes: providerMaxBytes(store),
      endpoint: store.endpoint || '',
      bucket: store.bucket || '',
      region: store.region || '',
      pathStyle: store.pathStyle !== false,
      usedBytes: u.bytes,
      files: u.files,
    },
    ...page,
  };
}

export async function readStoreFile(env, storeId, key) {
  const k = safeKey(key);
  if (!k) return { error: '文件路径不合法' };
  const settings = await getRaw(env, { fresh: true });
  const found = findStore(settings, env, storeId);
  if (found.error) return { error: found.error };
  const bytes = await found.adapter.get(k);
  if (!bytes) return { error: '文件不存在' };
  return { bytes, storeId: found.store.id, key: k };
}

export async function writeStoreFile(env, storeId, key, bytes, contentType = '') {
  const k = safeKey(key);
  if (!k) return { error: '文件路径不合法' };
  const size = bytes.byteLength ?? bytes.length ?? 0;
  if (size > 2 * 1024 * 1024) return { error: '单个文件不能超过 2 MB' };
  const settings = await getRaw(env, { fresh: true });
  const found = findStore(settings, env, storeId);
  if (found.error) return { error: found.error };
  const { store, adapter } = found;
  const oldSize = await adapter.head(k).catch(() => null);
  await adapter.put(k, bytes, contentType);
  await addUsage(env, store.id, size - (Number(oldSize) || 0), oldSize === null ? 1 : 0);
  return { ok: true, key: k, bytes: size };
}

export async function deleteStoreFile(env, storeId, key) {
  const k = safeKey(key);
  if (!k) return { error: '文件路径不合法' };
  const settings = await getRaw(env, { fresh: true });
  const found = findStore(settings, env, storeId);
  if (found.error) return { error: found.error };
  const { store, adapter } = found;
  const size = await adapter.head(k).catch(() => null);
  if (size === null) return { error: '文件不存在' };
  await adapter.delete(k);
  await addUsage(env, store.id, -Number(size || 0), -1);
  return { ok: true, key: k };
}

// ---------------------------------------------------------------------------
// 面板用:状态总览 + 自动检测
// ---------------------------------------------------------------------------

export async function status(env) {
  const settings = await getRaw(env, { fresh: true });
  const stores = resolveStores(settings, env);
  const usage = await usageMap(env);
  let primary = null;
  const out = [];
  const warnings = [];
  for (const s of stores) {
    const av = availability(env, s);
    const u = usage[s.id] || { bytes: 0, files: 0 };
    const isPrimary = av.ok && s.enabled && !primary;
    if (isPrimary) primary = s.id;
    out.push({
      id: s.id,
      kind: s.kind,
      name: s.name || s.id,
      builtin: !!s.builtin,
      enabled: !!s.enabled,
      priority: Number(s.priority) || 0,
      maxBytes: Number(s.maxBytes) || 0,
      available: av.ok,
      reason: av.reason || '',
      usedBytes: u.bytes,
      files: u.files,
      primary: isPrimary,
      endpoint: s.endpoint || '',
      bucket: s.bucket || '',
      region: s.region || '',
      accessKey: s.accessKey ? `${String(s.accessKey).slice(0, 4)}****` : '',
      pathStyle: s.pathStyle !== false,
    });
    if (!s.enabled) continue;
    if (!av.ok) {
      const wouldBePrimary = !stores.some((x) => x.enabled && availability(env, x).ok && Number(x.priority) > Number(s.priority));
      warnings.push({
        level: wouldBePrimary ? 'severe' : 'warn',
        text: `存储「${s.name || s.id}」已启用但不可用:${av.reason}`,
      });
    }
  }
  if (!primary) warnings.push({ level: 'severe', text: '没有任何可用的存储,部署功能不可用。请绑定 KV 或 R2。' });
  return {
    stores: out,
    primary,
    cacheKV: settings.storage?.cacheKV !== false,
    bindings: { db: !!env?.DB, kv: !!env?.STORE, r2: !!env?.R2 },
    warnings,
  };
}

// 登录面板时调用:检测到 R2 绑定就自动补进配置并启用(主存储)
export async function ensureDetected(env) {
  const settings = await getRaw(env, { fresh: true });
  const stores = Array.isArray(settings.storage?.stores) ? [...settings.storage.stores] : [];
  let changed = false;
  const notes = [];
  if (env?.R2 && !stores.some((s) => s.id === 'r2')) {
    stores.push({ id: 'r2', kind: 'r2', enabled: true, priority: 100, maxBytes: R2_DEFAULT_BYTES });
    changed = true;
    notes.push('检测到 R2 绑定,已自动设为主存储');
  }
  if (env?.STORE && !stores.some((s) => s.id === 'kv')) {
    stores.push({ id: 'kv', kind: 'kv', enabled: true, priority: 10, maxBytes: KV_DEFAULT_BYTES });
    changed = true;
  }
  if (changed) {
    await savePatch(env, { storage: { stores, initialized: true } });
  }
  return { changed, notes };
}
