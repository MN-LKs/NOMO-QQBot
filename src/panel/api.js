import { FIXED, missingEnv } from '../config.js';
import { getRaw, savePatch, maskSecrets } from '../store/settings.js';
import { list as logList, clear as logClear, cleanup as logCleanup, count as logCount, write as logWrite } from '../store/logs.js';
import { overview } from '../store/stats.js';
import * as P from '../store/projects.js';
import { quotaOf } from '../store/projects.js';
import { getFile, isImageCt, mimeFor } from '../store/kvfile.js';
import { all, ensureSchema, one, run } from '../store/db.js';
import { listMcp, addMcp, updateMcp, removeMcp, testMcp } from '../agent/mcp.js';
import { webSearch } from '../agent/search.js';
import { chatOnce } from '../agent/llm.js';

const JSON_H = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };

export function jsonRes(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { ...JSON_H, ...extra } });
}

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function keepSecret(incoming, current) {
  if (incoming === undefined || incoming === null) return current;
  const s = String(incoming);
  if (s.includes('****')) return current;
  return s.trim();
}

function cleanHeaders(h) {
  const out = {};
  if (!h || typeof h !== 'object') return out;
  for (const [k, v] of Object.entries(h)) {
    const key = String(k || '').trim();
    if (!key) continue;
    if (/^(host|content-length|connection)$/i.test(key)) continue;
    out[key] = String(v ?? '').slice(0, 2000);
  }
  return out;
}

export async function handlePanelApi(request, env, url, ctx) {
  const path = url.pathname.replace(/^\/administrator\/api/, '') || '/';
  const method = request.method.toUpperCase();
  let body = null;
  if (method === 'POST' || method === 'PUT' || method === 'DELETE') {
    try {
      body = await request.json();
    } catch {
      body = null;
    }
  }
  const seg = path.split('/').filter(Boolean);

  try {
    if (path === '/logout' && method === 'POST') {
      return jsonRes({ ok: true });
    }
    if (path === '/me') {
      return jsonRes({ user: env.ADMIN_USER, missing: missingEnv(env) });
    }

    if (path === '/overview') {
      const d = await overview(env);
      const settings = await getRaw(env);
      const used = await P.totalUsed(env);
      const q = quotaOf(settings);
      const state = await coreState(env, ctx);
      return jsonRes({
        ...d,
        mode: settings.qq.mode,
        model: settings.llm.model,
        effort: settings.llm.deepThinking === false ? 'none' : settings.llm.reasoningEffort,
        quota: { ...q, used },
        state,
      });
    }

    if (path === '/settings' && method === 'GET') {
      const settings = await getRaw(env, { fresh: true });
      const q = quotaOf(settings);
      return jsonRes({
        settings: maskSecrets(settings),
        deploy: {
          ttlMinutes: Math.round(settings.deploy.ttlSeconds / 60),
          extendMinutes: Math.round(settings.deploy.extendSeconds / 60),
        },
        quota: q,
        maxFileBytes: FIXED.maxFileBytes,
        callbackUrl: callbackUrl(env, url, settings),
        modeText: settings.qq.mode === 'webhook' ? '当前:WebHook 模式' : '当前:WebSocket 模式',
      });
    }

    if (path === '/settings' && method === 'POST') {
      const cur = await getRaw(env, { fresh: true });
      const patch = body || {};
      const notes = [];
      if (patch.llm) {
        patch.llm = {
          ...patch.llm,
          apiKey: keepSecret(patch.llm.apiKey, cur.llm.apiKey),
          headers: cleanHeaders(patch.llm.headers),
        };
      }
      if (patch.search) {
        patch.search = {
          ...patch.search,
          key: keepSecret(patch.search.key, cur.search.key),
          headers: cleanHeaders(patch.search.headers),
        };
      }
      if (patch.qq) {
        patch.qq = { ...patch.qq, appSecret: keepSecret(patch.qq.appSecret, cur.qq.appSecret) };
      }
      if (patch.deploy && patch.deploy.maxProjects !== undefined) {
        const merged = { ...cur, deploy: { ...cur.deploy, ...patch.deploy } };
        const q = quotaOf(merged);
        if (q.clamped) {
          patch.deploy.maxProjects = q.capacity;
          notes.push(`同时部署数量超过 KV 容量,已自动调整到 ${q.capacity} 个`);
        }
      }
      const next = await savePatch(env, patch);
      const needApply = patch.qq || patch.llm || patch.search;
      if (needApply) {
        const r = await coreApply(env, ctx);
        if (r) notes.push(r);
      }
      return jsonRes({ ok: true, settings: maskSecrets(next), note: notes.join(';') });
    }

    if (path === '/models' && method === 'POST') {
      const baseUrl = String(body?.baseUrl || '').replace(/\/+$/, '');
      const apiKey = String(body?.apiKey || '');
      const headers = cleanHeaders(body?.headers);
      if (!baseUrl) return jsonRes({ error: '请先填写接口地址' }, 400);
      const res = await fetch(`${baseUrl}/models`, {
        headers: { ...headers, ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}), 'User-Agent': 'NPAPI/3.0' },
      });
      const text = await res.text();
      if (!res.ok) return jsonRes({ error: `接口返回 HTTP ${res.status}:${text.slice(0, 300)}` }, 400);
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        return jsonRes({ error: '接口返回的不是 JSON,可能地址不对' }, 400);
      }
      const list = (data.data || data.models || [])
        .map((m) => (typeof m === 'string' ? m : m.id || m.name))
        .filter(Boolean);
      if (!list.length) return jsonRes({ error: '接口没有返回任何模型' }, 400);
      return jsonRes({ models: list.slice(0, 300) });
    }

    if (path === '/test-llm' && method === 'POST') {
      const baseUrl = String(body?.baseUrl || '').replace(/\/+$/, '');
      const apiKey = String(body?.apiKey || '');
      const headers = cleanHeaders(body?.headers);
      const model = String(body?.model || '');
      const cfg = {
        ...FIXED,
        llmBaseUrl: baseUrl,
        llmApiKey: apiKey,
        llmHeaders: headers,
        llmModel: model,
        reasoningEffort: 'minimal',
        deepThinking: false,
      };
      const out = { model, chat: null, tool: null };
      try {
        const r = await chatOnce(cfg, [{ role: 'user', content: 'Hello, Introduce yourself briefly.' }], null, { timeoutMs: 60000 });
        out.chat = {
          ok: !!r.content && r.content.trim().length > 0,
          detail: `HTTP 正常 · ${r.elapsedMs}ms · 返回 ${r.content ? r.content.length : 0} 字`,
          reply: r.content || '',
        };
      } catch (e) {
        out.chat = { ok: false, detail: String(e?.message || e) };
      }
      try {
        const toolDef = [{
          type: 'function',
          function: {
            name: 'get_current_time',
            description: 'Get the current time. Call this whenever the user asks for the time.',
            parameters: { type: 'object', properties: {}, required: [] },
            strict: true,
          },
        }];
        const r = await chatOnce(cfg,
          [{ role: 'user', content: 'What time is it right now? Use the tool you have to find out.' }],
          toolDef, { timeoutMs: 60000 });
        const calls = r.toolCalls || [];
        const ok = calls.length > 0 && calls[0].function?.name === 'get_current_time';
        out.tool = {
          ok,
          detail: ok
            ? `模型正确调用了 get_current_time(${calls[0].function?.arguments || '{}'})`
            : `模型没有调用工具${calls.length ? `,而是调用了 ${calls.map((c) => c.function?.name).join(', ')}` : ''}`,
        };
      } catch (e) {
        out.tool = { ok: false, detail: String(e?.message || e) };
      }
      return jsonRes(out);
    }

    if (path === '/test-search' && method === 'POST') {
      const settings = await getRaw(env, { fresh: true });
      const q = String(body?.query || 'test');
      const cfg = {
        ...FIXED,
        searchApiUrl: settings.search.url,
        searchApiKey: settings.search.key,
        searchHeaders: settings.search.headers,
      };
      if (!cfg.searchApiUrl) return jsonRes({ error: '还没有配置搜索接口地址' }, 400);
      const r = await webSearch(cfg, q, 3);
      return jsonRes({ ok: true, result: String(r).slice(0, 4000) });
    }

    if (seg[0] === 'projects') {
      return await projectsApi(request, env, url, seg, method, body);
    }

    if (seg[0] === 'logs') {
      return await logsApi(env, seg, method, url);
    }

    if (seg[0] === 'mcp') {
      return await mcpApi(env, seg, method, body);
    }

    if (seg[0] === 'groups' && method === 'POST') {
      const openid = String(body?.openid || '').trim();
      if (!openid) return jsonRes({ error: '请填写 openID' }, 400);
      const settings = await getRaw(env, { fresh: true });
      const list = (settings.groups.list || []).filter((g) => g.openid !== openid);
      if (body.action !== 'remove') list.unshift({ openid, addedAt: Date.now() });
      await savePatch(env, { groups: { list } });
      return jsonRes({ ok: true, list });
    }

    if (seg[0] === 'admins' && method === 'POST') {
      const openid = String(body?.openid || '').trim();
      if (!openid) return jsonRes({ error: '请填写 openID' }, 400);
      const settings = await getRaw(env, { fresh: true });
      const list = (settings.admin.openIds || []).filter((g) => g.openid !== openid);
      if (body.action !== 'remove') list.unshift({ openid, addedAt: Date.now() });
      await savePatch(env, { admin: { openIds: list } });
      return jsonRes({ ok: true, list });
    }

    return jsonRes({ error: 'not found', path }, 404);
  } catch (e) {
    await logWrite(env, 'error', 'panel', `面板接口出错 ${path}: ${e?.stack || e}`);
    return jsonRes({ error: String(e?.message || e) }, 500);
  }
}

async function projectsApi(request, env, url, seg, method, body) {
  const settings = await getRaw(env, { fresh: true });
  const base = settings.site.publicBaseUrl || `${url.protocol}//${url.host}`;
  const extendMinutes = Math.round(settings.deploy.extendSeconds / 60);

  if (seg.length === 1 && method === 'GET') {
    const rows = await P.listProjects(env);
    const used = await P.totalUsed(env);
    const q = quotaOf(settings);
    const items = [];
    for (const r of rows) {
      const u = await P.usage(env, r.id);
      items.push({
        id: r.id,
        name: r.name,
        description: r.description,
        url: `${base}/${r.id}`,
        bytes: u.bytes + u.dataBytes,
        hits: Number(r.hits || 0),
        files: u.files,
        expiresAt: Number(r.expires_at),
        createdAt: Number(r.created_at),
        source: r.source,
      });
    }
    return jsonRes({ projects: items, quota: { ...q, used }, extendMinutes });
  }

  if (seg.length === 1 && method === 'POST') {
    const files = Array.isArray(body?.files) ? body.files : [];
    if (!files.length) return jsonRes({ error: '至少需要一个文件' }, 400);
    for (const f of files) {
      if (String(f.content || '').length > FIXED.maxFileBytes) {
        return jsonRes({ error: `文件 ${f.path} 超过单文件上限 ${Math.round(FIXED.maxFileBytes / 1024)} KB` }, 400);
      }
    }
    const id = pickId(env, settings);
    const r = await P.createProject(env, settings, {
      id,
      name: String(body?.name || '未命名项目').slice(0, 60),
      description: String(body?.description || '').slice(0, 200),
      owner: env.ADMIN_USER,
      source: 'panel',
      files: files.map((f) => ({ path: f.path, content: f.content, ct: f.ct || mimeFor(f.path) })),
      ttlSeconds: Math.max(60, num(body?.ttlMinutes, 10) * 60),
    });
    if (r.error) return jsonRes({ error: r.error }, 400);
    /* 计数在 createProject 里统一做 */
    await logWrite(env, 'info', 'panel', `面板部署项目 ${r.id}(${body?.name || ''})`);
    return jsonRes({ ok: true, id: r.id, url: `${base}/${r.id}` });
  }

  const id = seg[1];
  if (seg.length === 2 && method === 'GET') {
    const p = await P.getProject(env, id);
    if (!p) return jsonRes({ error: '项目不存在或已过期' }, 404);
    const u = await P.usage(env, id);
    const lim = await P.limitsFor(env, settings, id);
    const files = await P.listFiles(env, id);
    return jsonRes({
      project: {
        id: p.id,
        name: p.name,
        description: p.description,
        owner: p.owner,
        source: p.source,
        url: `${base}/${p.id}`,
        hits: Number(p.hits || 0),
        expiresAt: Number(p.expires_at),
        createdAt: Number(p.created_at),
      },
      usage: u,
      quota: { base: lim.base, share: lim.share, limit: lim.limit, dynamicAvail: lim.dynamicAvail, used: lim.quota.used },
      files: files.map((f) => ({ path: f.path, size: Number(f.size), rawSize: Number(f.raw_size), ct: f.ct || 'text/plain', gz: !!f.gz })),
      extendMinutes,
      dataQuota: settings.deploy.dataQuotaBytes,
    });
  }

  if (seg.length === 2 && method === 'DELETE') {
    const r = await P.removeProject(env, id);
    if (r.error) return jsonRes({ error: r.error }, 404);
    await logWrite(env, 'info', 'panel', `面板删除项目 ${id}(${r.name || ''})`);
    return jsonRes({ ok: true });
  }

  if (seg.length === 3 && seg[2] === 'extend' && method === 'POST') {
    const secs = Math.max(60, num(body?.seconds, settings.deploy.extendSeconds));
    const r = await P.extendProject(env, id, secs);
    if (r.error) return jsonRes({ error: r.error }, 404);
    return jsonRes({ ok: true, expiresAt: r.expiresAt });
  }

  if (seg.length === 3 && seg[2] === 'file' && method === 'GET') {
    const path = url.searchParams.get('path') || '';
    const rows = await P.listFiles(env, id);
    const meta = rows.find((f) => f.path === path);
    if (!meta) return jsonRes({ error: '文件不存在' }, 404);
    const bytes = await getFile(env, id, path, meta.gz);
    if (!bytes) return jsonRes({ error: '文件内容已丢失' }, 404);
    const ct = meta.ct || mimeFor(path);
    if (isImageCt(ct) || /^video\//.test(ct) || /^audio\//.test(ct)) {
      if (bytes.byteLength > 3 * 1024 * 1024) {
        return jsonRes({ kind: 'binary', ct, size: bytes.byteLength, data: '' });
      }
      return jsonRes({ kind: ct.split('/')[0], ct, size: bytes.byteLength, data: `data:${ct};base64,${b64(bytes)}` });
    }
    if (/^text\/|json|javascript|xml|svg/.test(ct)) {
      const text = new TextDecoder().decode(bytes);
      return jsonRes({ kind: 'text', ct, size: bytes.byteLength, data: text.slice(0, 200000) });
    }
    return jsonRes({ kind: 'binary', ct, size: bytes.byteLength, data: '' });
  }

  return jsonRes({ error: 'not found' }, 404);
}

async function logsApi(env, seg, method, url) {
  if (seg.length === 1 && method === 'GET') {
    const settings = await getRaw(env);
    const level = url.searchParams.get('level') || '';
    const limit = Math.min(1000, num(url.searchParams.get('limit'), 300));
    const logs = await logList(env, { level, limit });
    const count = await logCount(env);
    return jsonRes({ logs, count, debug: !!settings.logs.debug, retentionDays: settings.logs.retentionDays, maxRows: settings.logs.maxRows });
  }
  if (seg.length === 1 && method === 'DELETE') {
    await logClear(env);
    return jsonRes({ ok: true });
  }
  if (seg.length === 2 && seg[1] === 'cleanup' && method === 'POST') {
    const settings = await getRaw(env);
    const n = await logCleanup(env, settings.logs);
    return jsonRes({ ok: true, count: n });
  }
  if (seg.length === 2 && seg[1] === 'download' && method === 'GET') {
    const logs = await logList(env, { limit: 1000 });
    const text = logs.map((l) => `${new Date(l.ts).toISOString()} [${l.level}] ${l.msg}`).join('\n');
    return new Response(text, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="npapi-logs-${new Date().toISOString().slice(0, 10)}.txt"`,
        'Cache-Control': 'no-store',
      },
    });
  }
  return jsonRes({ error: 'not found' }, 404);
}

async function mcpApi(env, seg, method, body) {
  if (seg.length === 1 && method === 'GET') {
    return jsonRes({ servers: await listMcp(env) });
  }
  if (seg.length === 1 && method === 'POST') {
    const r = await addMcp(env, {
      name: String(body?.name || '').slice(0, 40),
      url: String(body?.url || '').trim(),
      transport: String(body?.transport || 'auto'),
      headers: cleanHeaders(body?.headers),
    });
    if (r.error) return jsonRes({ error: r.error }, 400);
    return jsonRes({ ok: true, id: r.id, note: r.note });
  }
  const id = seg[1];
  if (seg.length === 2 && method === 'POST') {
    if (body?.tool !== undefined) {
      await updateMcp(env, id, { tool: body.tool, on: !!body.on });
    } else {
      await updateMcp(env, id, { enabled: !!body?.enabled });
    }
    return jsonRes({ ok: true });
  }
  if (seg.length === 2 && method === 'DELETE') {
    await removeMcp(env, id);
    return jsonRes({ ok: true });
  }
  if (seg.length === 3 && seg[2] === 'test' && method === 'POST') {
    const r = await testMcp(env, id);
    if (r.error) return jsonRes({ error: r.error }, 400);
    return jsonRes({ ok: true, count: r.count, tools: r.tools });
  }
  return jsonRes({ error: 'not found' }, 404);
}

function b64(bytes) {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

function pickId(env, settings) {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  for (let i = 0; i < 20; i++) {
    let s = '';
    const buf = new Uint8Array(8);
    crypto.getRandomValues(buf);
    for (const b of buf) s += chars[b % chars.length];
    if (!RESERVED.has(s)) return s;
  }
  return `p${Date.now().toString(36)}`;
}

const RESERVED = new Set([
  'qq', 'api', 'admin', 'administrator', 'health', 'check', 'favicon', 'robots',
  'index', 's', 'd', 'static', 'assets', '__data', 'cron', 'www', 'app', 'login',
  'logout', 'null', 'undefined', 'test', 'panel',
]);

function callbackUrl(env, url, settings) {
  const base = settings.site.publicBaseUrl || `${url.protocol}//${url.host}`;
  return `${base}${FIXED.webhookPath}`;
}

async function coreState(env, ctx) {
  try {
    const stub = env.BOT_CORE.get(env.BOT_CORE.idFromName('core'));
    const r = await stub.fetch('https://do/status');
    return await r.json();
  } catch (e) {
    return { error: String(e?.message || e) };
  }
}

async function coreApply(env, ctx) {
  try {
    const stub = env.BOT_CORE.get(env.BOT_CORE.idFromName('core'));
    const r = await stub.fetch('https://do/apply', { method: 'POST' });
    const d = await r.json();
    return d?.note || '';
  } catch (e) {
    return `应用到机器人失败:${String(e?.message || e)}`;
  }
}
