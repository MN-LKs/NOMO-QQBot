import { FIXED, missingEnv, normalizeApiBase, normalizeBaseUrl } from '../config.js';
import { getRaw, savePatch, maskSecrets, loadCfg, invalidate } from '../store/settings.js';
import { list as logList, clear as logClear, cleanup as logCleanup, count as logCount, write as logWrite } from '../store/logs.js';
import { overview } from '../store/stats.js';
import * as P from '../store/projects.js';
import { quotaOf } from '../store/projects.js';
import { getFile, isImageCt, mimeFor } from '../store/kvfile.js';
import { all, ensureSchema, one, run } from '../store/db.js';
import { listMcp, addMcp, updateMcp, removeMcp, testMcp } from '../agent/mcp.js';
import { testSearch } from '../agent/search.js';
import { chatOnce } from '../agent/llm.js';
import { status as storageStatus, availability, resolveStores, scanStore, storeDetail, readStoreFile, writeStoreFile, deleteStoreFile } from '../store/storage.js';
import { S3Client } from '../store/s3.js';
import { listModules, getModule, saveModule, removeModule } from '../store/modules.js';
import { listSkills, saveSkill, removeSkill, parseSkillDoc } from '../agent/skills.js';
import { loadExts, saveExt, removeExt } from '../agent/exts.js';
import { execBackend, sandboxFetch } from '../core/backend.js';
import { parseMotdTarget, queryMotd, formatMotdText } from '../agent/motd.js';
import { enhanceFiles } from '../util/seo.js';
import { checkCredentials } from './auth.js';

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

    if (!env.DB && !(path === '/me' || (path === '/settings' && method === 'GET')
      || path === '/update/check' || path === '/update/deploy')) {
      return jsonRes({ error: '没有绑定 D1 数据库(DB),这个功能暂时不可用;绑定后刷新本页。', missing: ['D1 数据库(DB)'] }, 503);
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
        const rawBase = patch.llm.baseUrl === undefined ? undefined : String(patch.llm.baseUrl || '').trim();
        patch.llm = {
          ...patch.llm,
          baseUrl: rawBase === undefined ? cur.llm.baseUrl : normalizeApiBase(rawBase),
          apiKey: keepSecret(patch.llm.apiKey, cur.llm.apiKey),
          headers: cleanHeaders(patch.llm.headers),
        };
        if (rawBase && patch.llm.baseUrl && rawBase !== patch.llm.baseUrl) {
          notes.push(`AI 接口地址已整理为 ${patch.llm.baseUrl}`);
        }
      }
      if (patch.search) {
        const rawBase = patch.search.baseUrl === undefined ? undefined : String(patch.search.baseUrl || '').trim();
        patch.search = {
          ...patch.search,
          baseUrl: rawBase === undefined ? cur.search.baseUrl : normalizeBaseUrl(rawBase),
          key: keepSecret(patch.search.key, cur.search.key),
          headers: cleanHeaders(patch.search.headers),
        };
        if (rawBase && patch.search.baseUrl && rawBase !== patch.search.baseUrl) {
          notes.push(`搜索接口地址已整理为 ${patch.search.baseUrl}`);
        }
      }
      if (patch.site && patch.site.publicBaseUrl !== undefined) {
        const rawBase = String(patch.site.publicBaseUrl || '').trim();
        patch.site = { ...patch.site, publicBaseUrl: normalizeBaseUrl(rawBase, { httpsOnly: true }) };
        if (rawBase && patch.site.publicBaseUrl && rawBase !== patch.site.publicBaseUrl) {
          notes.push(`站点域名已整理为 ${patch.site.publicBaseUrl}`);
        }
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
      const baseUrl = normalizeApiBase(body?.baseUrl);
      const apiKey = String(body?.apiKey || '');
      const headers = cleanHeaders(body?.headers);
      if (!baseUrl) return jsonRes({ error: '请先填写接口地址' }, 400);
      const res = await fetch(`${baseUrl}/models`, {
        headers: { ...headers, ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}), 'User-Agent': 'NOMO-QQBot/4.0' },
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
      const baseUrl = normalizeApiBase(body?.baseUrl);
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
      const cfg = await loadCfg(env);
      if (!cfg.searchApiUrl && !cfg.readerApiUrl) return jsonRes({ error: '还没有配置搜索接口地址' }, 400);
      const out = await testSearch(cfg, { query: body?.query, url: body?.url });
      return jsonRes({ ok: true, result: out });
    }

    if (path === '/test-motd' && method === 'POST') {
      const target = parseMotdTarget(body?.host);
      if (target.error) return jsonRes({ error: target.error }, 400);
      const cfg = await loadCfg(env);
      const r = await queryMotd(cfg, target.host, target.port || String(body?.port || ''));
      return jsonRes({ ok: r.ok, result: r, text: formatMotdText(r) });
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

    if (seg[0] === 'storage') {
      return await storageApi(env, seg, method, body, url);
    }

    if (seg[0] === 'modules') {
      return await modulesApi(env, seg, method, body);
    }

    if (seg[0] === 'skills') {
      return await skillsApi(env, seg, method, body);
    }

    if (seg[0] === 'exts') {
      return await extsApi(env, seg, method, body);
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

    if (path === '/update/check' && (method === 'GET' || method === 'POST')) {
      const cfg = await loadCfg(env).catch(() => ({}));
      return jsonRes(await checkUpdate(cfg));
    }

    if (path === '/update/deploy' && method === 'POST') {
      const cfg = await loadCfg(env).catch(() => ({}));
      const hook = String(cfg.updateDeployHook || '').trim();
      if (!hook) return jsonRes({ error: '没有配置 Cloudflare Deploy Hook,无法触发自动更新' }, 400);
      try {
        const res = await fetch(hook, { method: 'POST', headers: { 'User-Agent': 'NOMO-QQBot' } });
        return jsonRes({ ok: res.ok, status: res.status, note: res.ok ? '已触发部署,Cloudflare 会开始构建' : `Deploy Hook 返回 HTTP ${res.status}` });
      } catch (e) {
        return jsonRes({ error: `触发部署失败:${e?.message || e}` }, 502);
      }
    }

    if (path === '/reset' && method === 'POST') {
      if (!checkCredentials(env, body?.user, body?.pass)) {
        return jsonRes({ error: '管理员用户名或密码不对' }, 401);
      }
      if (!env.DB) return jsonRes({ error: '没有绑定 D1,无法重置配置和项目数据' }, 400);
      const tables = ['settings', 'stats', 'daily', 'groups', 'projects', 'files', 'sdata',
        'admins', 'mcp', 'logins', 'usage', 'logs', 'stusage', 'skills', 'exts', 'modules', 'meta'];
      await env.DB.batch(tables.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
      invalidate();

      let kvDeleted = 0;
      if (env.STORE) {
        let cursor;
        for (let i = 0; i < 10; i++) {
          const page = await env.STORE.list({ limit: 1000, cursor });
          for (const k of page.keys || []) {
            await env.STORE.delete(k.name);
            kvDeleted++;
          }
          if (page.list_complete || !page.cursor) break;
          cursor = page.cursor;
        }
      }

      let r2Deleted = 0;
      if (env.R2) {
        let cursor;
        for (let i = 0; i < 10; i++) {
          const page = await env.R2.list({ limit: 1000, cursor });
          for (const o of page.objects || []) {
            await env.R2.delete(o.key);
            r2Deleted++;
          }
          if (page.truncated === false || !page.cursor) break;
          cursor = page.cursor;
        }
      }

      if (env.BOT_CORE) {
        try {
          const stub = env.BOT_CORE.get(env.BOT_CORE.idFromName('core'));
          await stub.fetch('https://do/reset', { method: 'POST' });
        } catch {
          /* DO 重置失败不挡 D1 已清空 */
        }
      }
      return jsonRes({
        ok: true,
        kvDeleted,
        r2Deleted,
        note: `已重置。D1 表已清空,KV 删除 ${kvDeleted} 个键,R2 删除 ${r2Deleted} 个对象;S3 物理文件需在服务商后台删除。`,
      });
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
    // 面板粘贴部署同样补 SEO 兜底(缺失才补,已有的不覆盖)
    const enhanced = enhanceFiles(files, {
      name: String(body?.name || ''),
      description: String(body?.description || ''),
      url: `${base}/${id}`,
    });
    const r = await P.createProject(env, settings, {
      id,
      name: String(body?.name || '未命名项目').slice(0, 60),
      description: String(body?.description || '').slice(0, 200),
      owner: env.ADMIN_USER,
      source: 'panel',
      files: enhanced.map((f) => ({ path: f.path, content: f.content, ct: f.ct || mimeFor(f.path) })),
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
        'Content-Disposition': `attachment; filename="nomo-logs-${new Date().toISOString().slice(0, 10)}.txt"`,
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

async function storageApi(env, seg, method, body, url) {
  const settings = await getRaw(env, { fresh: true });
  const stores = Array.isArray(settings.storage?.stores) ? [...settings.storage.stores] : [];

  if (seg.length === 1 && method === 'GET') {
    return jsonRes({ status: await storageStatus(env) });
  }

  // 存储详情:基本信息 + 文件列表
  if (seg.length === 2 && method === 'GET') {
    const prefix = String(url?.searchParams?.get('prefix') || '');
    const cursor = String(url?.searchParams?.get('cursor') || '') || undefined;
    const limit = Math.max(1, Math.min(500, Number(url?.searchParams?.get('limit')) || 100));
    const r = await storeDetail(env, seg[1], { prefix, cursor, limit });
    if (r.error) return jsonRes({ error: r.error }, 404);
    return jsonRes(r);
  }

  if (seg.length === 3 && seg[2] === 'files' && method === 'GET') {
    const prefix = String(url?.searchParams?.get('prefix') || '');
    const cursor = String(url?.searchParams?.get('cursor') || '') || undefined;
    const limit = Math.max(1, Math.min(500, Number(url?.searchParams?.get('limit')) || 100));
    const r = await storeDetail(env, seg[1], { prefix, cursor, limit });
    if (r.error) return jsonRes({ error: r.error }, 404);
    return jsonRes(r);
  }

  if (seg.length === 3 && seg[2] === 'file') {
    const key = String(body?.path || url?.searchParams?.get('path') || '').trim();
    if (method === 'GET') {
      const r = await readStoreFile(env, seg[1], key);
      if (r.error) return jsonRes({ error: r.error }, 404);
      const name = key.split('/').pop() || key;
      const ct = mimeFor(name) || 'application/octet-stream';
      const textLike = /\.(html?|css|js|mjs|json|txt|md|markdown|xml|svg|csv|ya?ml|toml|ini|log)$/i.test(name)
        || ct.startsWith('text/') || ct.includes('json') || ct.includes('javascript') || ct.includes('xml');
      if (textLike) {
        return jsonRes({ kind: 'text', key, size: r.bytes.length, ct, text: new TextDecoder('utf-8').decode(r.bytes) });
      }
      return jsonRes({ kind: 'base64', key, size: r.bytes.length, ct, data: b64(r.bytes) });
    }
    if (method === 'POST' || method === 'PUT') {
      const encoding = body?.encoding === 'base64' ? 'base64' : 'text';
      let bytes;
      try {
        bytes = encoding === 'base64' ? unb64(String(body?.content || '')) : new TextEncoder().encode(String(body?.content || ''));
      } catch {
        return jsonRes({ error: '文件内容不是合法的 base64' }, 400);
      }
      const ct = String(body?.contentType || mimeFor(key) || 'text/plain');
      const r = await writeStoreFile(env, seg[1], key, bytes, ct);
      if (r.error) return jsonRes({ error: r.error }, 400);
      return jsonRes(r);
    }
    if (method === 'DELETE') {
      const r = await deleteStoreFile(env, seg[1], key);
      if (r.error) return jsonRes({ error: r.error }, 400);
      return jsonRes(r);
    }
  }

  if (seg.length === 2 && seg[1] === 'save' && method === 'POST') {
    const src = body?.store && typeof body.store === 'object' ? body.store : {};
    const id = String(src.id || '').trim();
    const cur = stores.find((s) => s.id === id) || {};
    let kind = String(src.kind || cur.kind || 's3');
    if (kind !== 'r2' && kind !== 'kv' && kind !== 's3') kind = 's3';
    const next = {
      id: id || (kind === 's3' ? `s3_${Math.random().toString(36).slice(2, 8)}` : kind),
      kind,
      name: String(src.name || cur.name || (kind === 's3' ? 'S3 存储' : kind === 'r2' ? 'R2 存储桶' : 'KV 命名空间')).slice(0, 40),
      enabled: src.enabled !== false,
      priority: Number.isFinite(Number(src.priority)) ? Number(src.priority) : (Number(cur.priority) || (kind === 'r2' ? 100 : kind === 'kv' ? 10 : 50)),
      maxBytes: Number(src.maxBytes) > 0 ? Math.round(Number(src.maxBytes)) : (Number(cur.maxBytes) || (kind === 'r2' ? 10 * 1024 ** 3 : kind === 'kv' ? 1024 ** 3 : 5 * 1024 ** 3)),
    };
    if (kind === 's3') {
      next.endpoint = String(src.endpoint ?? cur.endpoint ?? '').trim();
      next.bucket = String(src.bucket ?? cur.bucket ?? '').trim();
      next.region = String(src.region ?? cur.region ?? 'auto').trim() || 'auto';
      const ak = String(src.accessKey ?? '').trim();
      next.accessKey = ak && !ak.includes('****') ? ak : String(cur.accessKey || '');
      const sk = String(src.secretKey ?? '').trim();
      next.secretKey = sk && !sk.includes('****') ? sk : String(cur.secretKey || '');
      next.pathStyle = src.pathStyle !== false;
      if (!next.endpoint || !next.bucket || !next.accessKey || !next.secretKey) {
        return jsonRes({ error: 'S3 需要填全:endpoint / bucket / AccessKey / SecretKey' }, 400);
      }
    }
    const idx = stores.findIndex((s) => s.id === next.id);
    if (idx >= 0) stores[idx] = next;
    else stores.push(next);
    await savePatch(env, { storage: { stores, initialized: true } });
    return jsonRes({ ok: true, id: next.id });
  }

  if (seg.length === 2 && seg[1] === 'remove' && method === 'POST') {
    const id = String(body?.id || '');
    await savePatch(env, { storage: { stores: stores.filter((s) => s.id !== id) } });
    return jsonRes({ ok: true });
  }

  if (seg.length === 2 && seg[1] === 'test' && method === 'POST') {
    const id = String(body?.id || '');
    const s = resolveStores(settings, env).find((x) => x.id === id);
    if (!s) return jsonRes({ error: '存储不存在' }, 404);
    if (s.kind === 's3') {
      const r = await new S3Client(s).test();
      return jsonRes(r.ok ? { ok: true, note: r.note } : { ok: false, error: r.error });
    }
    const av = availability(env, s);
    return jsonRes(av.ok ? { ok: true, note: `${s.name} 绑定正常` } : { ok: false, error: av.reason });
  }

  if (seg.length === 2 && seg[1] === 'scan' && method === 'POST') {
    const id = String(body?.id || '');
    const s = resolveStores(settings, env).find((x) => x.id === id);
    if (!s) return jsonRes({ error: '存储不存在' }, 404);
    const r = await scanStore(env, s, { prefix: String(body?.prefix || '') });
    if (r.error) return jsonRes({ error: r.error }, 400);
    return jsonRes({ ok: true, bytes: r.bytes, files: r.files, providerMaxBytes: r.providerMaxBytes });
  }

  if (seg.length === 2 && seg[1] === 'cache' && method === 'POST') {
    await savePatch(env, { storage: { cacheKV: !!body?.enabled } });
    return jsonRes({ ok: true });
  }

  return jsonRes({ error: 'not found' }, 404);
}

async function modulesApi(env, seg, method, body) {
  if (seg.length === 1 && method === 'GET') {
    return jsonRes({ modules: await listModules(env) });
  }

  if (seg.length === 2 && seg[1] === 'save' && method === 'POST') {
    const m = body?.module && typeof body.module === 'object' ? body.module : {};
    const id = String(m.id || '').trim();
    if (!/^[a-zA-Z0-9_-]{2,32}$/.test(id)) {
      return jsonRes({ error: '模块 ID 只能用 2-32 位字母/数字/下划线/短横线(会作为工具名发给模型)' }, 400);
    }
    const code = String(m.code || '');
    if (!code.trim()) return jsonRes({ error: '代码不能为空' }, 400);
    if (code.length > FIXED.moduleMaxCode) return jsonRes({ error: `代码超过上限 ${FIXED.moduleMaxCode} 字符` }, 400);
    let params = {};
    if (m.params && typeof m.params === 'object') params = m.params;
    else if (typeof m.params === 'string' && m.params.trim()) {
      try {
        params = JSON.parse(m.params);
      } catch {
        return jsonRes({ error: '参数定义不是合法 JSON' }, 400);
      }
    }
    const callPoints = Array.isArray(m.callPoints) ? m.callPoints.filter((x) => x === 'agent' || x === 'site') : [];
    const cur = await getModule(env, id);
    await saveModule(env, {
      id,
      name: String(m.name || id).slice(0, 40),
      description: String(m.description || '').slice(0, 200),
      code,
      params,
      callPoints,
      method: String(m.method || 'ANY').toUpperCase().slice(0, 10),
      path: String(m.path || '').slice(0, 100),
      enabled: m.enabled !== false,
      timeoutMs: Math.max(500, Math.min(30000, Number(m.timeoutMs) || 5000)),
      createdAt: cur?.createdAt || Date.now(),
    });
    return jsonRes({ ok: true, id });
  }

  if (seg.length === 2 && seg[1] === 'remove' && method === 'POST') {
    await removeModule(env, String(body?.id || ''));
    return jsonRes({ ok: true });
  }

  if (seg.length === 2 && seg[1] === 'test' && method === 'POST') {
    const mod = await getModule(env, String(body?.id || ''));
    if (!mod) return jsonRes({ error: '模块不存在' }, 404);
    const r = await execBackend(mod.code, {
      args: body?.args && typeof body.args === 'object' ? body.args : {},
      fetch: (url, init) => sandboxFetch(url, init, mod.timeoutMs),
      now: () => Date.now(),
      json: (x) => JSON.parse(String(x)),
      text: (x) => JSON.stringify(x),
    }, { timeoutMs: mod.timeoutMs || 5000 });
    return jsonRes({ ok: r.ok, value: r.value ?? null, error: r.error || '', logs: r.logs || [] });
  }

  return jsonRes({ error: 'not found' }, 404);
}

async function skillsApi(env, seg, method, body) {
  if (seg.length === 1 && method === 'GET') {
    return jsonRes({ skills: await listSkills(env) });
  }

  if (seg.length === 2 && seg[1] === 'save' && method === 'POST') {
    const src = body?.skill && typeof body.skill === 'object' ? body.skill : {};
    const skill = {
      id: String(src.id || '').trim(),
      name: String(src.name || '').trim().slice(0, 60),
      description: String(src.description || '').trim().slice(0, 200),
      triggers: Array.isArray(src.triggers)
        ? src.triggers.map((x) => String(x).trim()).filter(Boolean)
        : String(src.triggers || '').split(/[,,\s]+/).map((x) => x.trim()).filter(Boolean),
      content: String(src.content || ''),
      enabled: src.enabled !== false,
    };
    if (src.doc) {
      const doc = parseSkillDoc(String(src.doc));
      if (doc.name && !skill.name) skill.name = doc.name.slice(0, 60);
      if (doc.description && !skill.description) skill.description = doc.description.slice(0, 200);
      if (!skill.triggers.length && doc.triggers.length) skill.triggers = doc.triggers;
      if (doc.content) skill.content = doc.content;
    }
    if (!skill.name) return jsonRes({ error: '请填写技能名称' }, 400);
    if (!skill.content.trim()) return jsonRes({ error: '技能内容不能为空' }, 400);
    if (!skill.id) skill.id = `skill_${Math.random().toString(36).slice(2, 8)}`;
    await saveSkill(env, skill);
    return jsonRes({ ok: true, id: skill.id });
  }

  if (seg.length === 2 && seg[1] === 'remove' && method === 'POST') {
    await removeSkill(env, String(body?.id || ''));
    return jsonRes({ ok: true });
  }

  return jsonRes({ error: 'not found' }, 404);
}

async function extsApi(env, seg, method, body) {
  if (seg.length === 1 && method === 'GET') {
    return jsonRes(await loadExts(env));
  }

  if (seg.length === 2 && seg[1] === 'toggle' && method === 'POST') {
    const id = String(body?.id || '').trim();
    if (!id) return jsonRes({ error: '缺少 id' }, 400);
    await saveExt(env, { id, kind: 'builtin', enabled: !!body?.enabled });
    return jsonRes({ ok: true });
  }

  if (seg.length === 2 && seg[1] === 'save' && method === 'POST') {
    const src = body?.ext && typeof body.ext === 'object' ? body.ext : {};
    const id = String(src.id || '').trim();
    if (!/^[a-zA-Z0-9_-]{2,32}$/.test(id)) {
      return jsonRes({ error: '扩展 ID 只能用 2-32 位字母/数字/下划线/短横线' }, 400);
    }
    let config = {};
    if (typeof src.config === 'string' && src.config.trim()) {
      try {
        config = JSON.parse(src.config);
      } catch {
        return jsonRes({ error: '工具定义不是合法 JSON' }, 400);
      }
    } else if (src.config && typeof src.config === 'object') {
      config = src.config;
    }
    if (!Array.isArray(config.tools) || !config.tools.length) {
      return jsonRes({ error: 'config.tools 需要是非空数组,至少定义一个工具' }, 400);
    }
    await saveExt(env, {
      id,
      kind: 'external',
      name: String(src.name || id).slice(0, 40),
      description: String(src.description || '').slice(0, 200),
      config,
      enabled: src.enabled !== false,
    });
    return jsonRes({ ok: true, id });
  }

  if (seg.length === 2 && seg[1] === 'remove' && method === 'POST') {
    await removeExt(env, String(body?.id || ''));
    return jsonRes({ ok: true });
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

function unb64(text) {
  const bin = atob(String(text || ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
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
  const base = normalizeBaseUrl(settings.site.publicBaseUrl, { httpsOnly: true }) || `${url.protocol}//${url.host}`;
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

function versionParts(v) {
  return String(v || '').replace(/^v/i, '').split('.').map((x) => Number(x) || 0);
}

function newerVersion(remote, current) {
  const a = versionParts(remote);
  const b = versionParts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return false;
}

async function checkUpdate(cfg) {
  const repo = String(cfg.updateRepo || FIXED.updateRepo).replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');
  const headers = { 'User-Agent': 'NOMO-QQBot/4.1', 'Accept': 'application/vnd.github+json' };
  const out = {
    current: FIXED.appVersion,
    repo,
    latestVersion: '',
    latestSha: '',
    latestMessage: '',
    latestDate: '',
    updateAvailable: false,
    force: false,
    note: '',
  };
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/commits/main`, { headers, signal: AbortSignal.timeout(15000) });
    if (res.ok) {
      const c = await res.json();
      out.latestSha = String(c?.sha || '').slice(0, 8);
      out.latestMessage = String(c?.commit?.message || '').split('\n')[0].slice(0, 200);
      out.latestDate = c?.commit?.author?.date || '';
      out.force = /\[force-update\]|FORCE_UPDATE/i.test(out.latestMessage);
    }
  } catch (e) {
    out.note = `读取 GitHub 提交失败:${e?.message || e}`;
  }
  try {
    const res = await fetch(`https://raw.githubusercontent.com/${repo}/main/package.json`, {
      headers: { 'User-Agent': 'NOMO-QQBot/4.1' }, signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      const pkg = await res.json();
      out.latestVersion = String(pkg?.version || '');
      out.updateAvailable = newerVersion(out.latestVersion, out.current);
    }
  } catch {
    /* 版本号读不到时只显示提交信息 */
  }
  return out;
}
