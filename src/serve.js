import { CSP_PANEL, CSP_SITE } from './config.js';
import { getProject, bumpHits, dataGet, dataSet, dataDel, dataList } from './store/projects.js';
import { getFileAuto, mimeFor } from './store/kvfile.js';
import { bump, bumpDaily } from './store/stats.js';
import { getModule } from './store/modules.js';
import { execBackend, sandboxFetch, normalizeBackendResult } from './core/backend.js';
import { logWrite } from './store/logs.js';
import { isSiteId } from './util/id.js';

let pending = new Map();
let pendingVisits = 0;
let lastFlush = 0;

export function splitSitePath(pathname) {
  const parts = String(pathname || '').split('/').filter(Boolean);
  if (!parts.length) return { id: '', rest: '' };
  return { id: safeDecode(parts[0]), rest: parts.slice(1).map(safeDecode).join('/') };
}

// URL 里的路径是 percent-encoded 的(中文 ID、带空格的子文件),
// 不还原的话查库永远查不到。编码坏了就当原样,交给 ID 校验去拒绝。
function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function noteView(env, ctx, id) {
  pending.set(id, (pending.get(id) || 0) + 1);
  pendingVisits++;
  const total = [...pending.values()].reduce((a, b) => a + b, 0);
  if (total >= 10 || Date.now() - lastFlush > 30000) {
    lastFlush = Date.now();
    const snapshot = [...pending.entries()];
    pending = new Map();
    const visits = pendingVisits;
    pendingVisits = 0;
    ctx?.waitUntil((async () => {
      for (const [sid, n] of snapshot) {
        try {
          await bumpHits(env, sid, n);
        } catch {
          /* ignore */
        }
      }
      try {
        await bump(env, 'visits', visits);
        await bumpDaily(env, 'visits', visits);
      } catch {
        /* ignore */
      }
    })());
  }
}

export function page(code, msg, status = 404, note = '这个页面由 NOMO-QQBot 临时部署,到期会自动销毁') {
  return new Response(
    `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">`
    + `<title>${code}</title><style>body{font:15px/1.7 -apple-system,"PingFang SC",sans-serif;display:flex;align-items:center;`
    + `justify-content:center;min-height:100vh;margin:0;background:#0f172a;color:#e2e8f0}div{text-align:center;padding:30px}`
    + `b{font-size:17px}h1{font-size:52px;margin:0 0 8px;color:#3b82f6}p{color:#94a3b8;font-size:13px}</style></head>`
    + `<body><div><h1>${code}</h1><b>${msg}</b><p>${note}</p></div></body></html>`,
    {
      status,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': CSP_PANEL,
        'X-Frame-Options': 'DENY',
      },
    });
}

export async function serveSite(env, cfg, request, url, ctx) {
  const { id, rest } = splitSitePath(url.pathname);
  if (!id) return null;

  const p = await getProject(env, id);
  if (!p) return page('404', '页面不存在');
  if (Number(p.expires_at) <= Date.now()) return page('404', '页面已过期');

  if (rest.startsWith('__data/')) {
    if (!cfg.allowData) return json({ error: '数据存储已被关闭' }, 403);
    const key = rest.slice('__data/'.length);
    if (!key || key.length > 64) return json({ error: 'key 不合法' }, 400);
    if (request.method === 'GET') {
      const v = await dataGet(env, id, key);
      return json({ key, value: v });
    }
    if (request.method === 'POST' || request.method === 'PUT') {
      const body = await request.text();
      if (body.length > 64 * 1024) return json({ error: '单条数据不能超过 64 KB' }, 413);
      const r = await dataSet(env, id, key, body, cfg.dataQuotaBytes);
      if (r.error) return json({ error: r.error }, 507);
      return json({ ok: true });
    }
    return json({ error: '只支持 GET / POST' }, 405);
  }

  const filePath = rest || 'index.html';
  // 自定义后端只由 /api/ 路由执行,永远不当作静态文件公开
  if (filePath === '_backend.js') return page('404', `找不到文件 ${filePath}`);
  // 直读 KV(靠魔数判断是否压缩),不再先查一次 D1 文件表 —— 少一次查询,页面更快
  const bytes = await getFileAuto(env, id, filePath);
  if (!bytes) {
    if (!rest) return page('404', '这个项目还没有 index.html');
    return page('404', `找不到文件 ${filePath}`);
  }

  if (!rest || /\.html?$/i.test(filePath)) noteView(env, ctx, id);

  const ct = mimeFor(filePath);
  const headers = {
    'Content-Type': ct,
    'Cache-Control': 'public, max-age=60',
    'X-Content-Type-Options': 'nosniff',
  };
  // AI 生成的页面统一挂一个宽松 CSP:允许内联脚本/样式与 https 资源,禁止 http 与插件
  if (/^text\/html/i.test(ct)) {
    headers['Content-Security-Policy'] = CSP_SITE;
    headers['X-Frame-Options'] = 'SAMEORIGIN';
  }
  if (request.method === 'HEAD') return new Response(null, { headers });
  return new Response(bytes, { headers });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

// 保留路径:既不能当站点 ID,也不能从 Referer 里认成站点
export const RESERVED = new Set([
  'qq', 'api', 'admin', 'administrator', 'health', 'check', 'favicon', 'robots',
  'index', 's', 'd', 'static', 'assets', '__data', 'cron', 'www', 'app', 'login',
  'logout', 'null', 'undefined', 'test', 'panel', 'v1',
]);

// 站点后端接口:
//   /api/<模块id>   → 管理员在「模块」里勾了「站点后端」的预制模块(全局,与站点无关)
//   /api/<任意路径> → 当前页面所属站点的 _backend.js(沙盒执行,站点从 Referer 认)
// 页面里 fetch("/api/…") 走这里;带每分钟每 IP 的频率限制。
export async function handleSiteApi(env, cfg, request, url) {
  const rest = url.pathname.replace(/^\/api\/?/, '');
  if (!rest) return json({ error: '缺少接口路径' }, 404);
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'POST') return json({ error: '只支持 GET / POST' }, 405);

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (!rateOk(ip, cfg.apiPerMinute || 60)) return json({ error: '请求太频繁,请稍后再试' }, 429);

  const first = rest.split('/')[0];

  // 1) 预制模块
  if (cfg.canPrefab) {
    const mod = await getModule(env, first);
    if (mod && mod.enabled && Array.isArray(mod.callPoints) && mod.callPoints.includes('site')) {
      const args = method === 'POST' ? await readJsonBody(request) : queryObject(url);
      const r = await execBackend(mod.code, {
        args,
        fetch: (u, init) => sandboxFetch(u, init, mod.timeoutMs),
        now: () => Date.now(),
        json: (x) => JSON.parse(String(x)),
        text: (x) => JSON.stringify(x),
      }, { timeoutMs: mod.timeoutMs || 5000 });
      if (!r.ok) {
        await logWrite(env, 'warn', 'site', `模块 ${mod.id} 接口执行失败:${r.error}`).catch(() => null);
        return json({ error: `模块执行失败:${r.error}` }, 500);
      }
      return backendResponse(r.value);
    }
  }

  // 2) 站点自定义后端(_backend.js)
  if (cfg.canCustomBackend) {
    const siteId = siteFromReferer(request);
    if (siteId && isSiteId(siteId)) {
      const p = await getProject(env, siteId);
      if (p && Number(p.expires_at) > Date.now()) {
        const codeBytes = await getFileAuto(env, siteId, '_backend.js');
        if (codeBytes) {
          const bodyText = method === 'POST' ? await request.text() : '';
          if (bodyText.length > 256 * 1024) return json({ error: '请求体太大' }, 413);
          const r = await execBackend(new TextDecoder().decode(codeBytes), {
            method,
            path: rest,
            query: queryObject(url),
            headers: publicHeaders(request),
            body: bodyText,
            json: () => JSON.parse(bodyText || '{}'),
            store: {
              get: (k) => dataGet(env, siteId, k),
              set: async (k, v) => {
                const rr = await dataSet(env, siteId, String(k), typeof v === 'string' ? v : JSON.stringify(v), cfg.dataQuotaBytes);
                if (rr.error) throw new Error(rr.error);
                return true;
              },
              del: (k) => dataDel(env, siteId, k),
              list: () => dataList(env, siteId),
            },
            fetch: (u, init) => sandboxFetch(u, init, 15000),
            now: () => Date.now(),
          }, { timeoutMs: 5000 });
          if (!r.ok) {
            await logWrite(env, 'warn', 'site', `站点 ${siteId} 后端执行失败:${r.error}`).catch(() => null);
            return json({ error: `后端执行失败:${r.error}` }, 500);
          }
          return backendResponse(r.value);
        }
      }
    }
  }

  return json({ error: '没有这个接口' }, 404);
}

function backendResponse(value) {
  const out = normalizeBackendResult(value);
  return new Response(out.body, {
    status: out.status,
    headers: {
      'Content-Type': out.contentType,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...out.headers,
    },
  });
}

const apiHits = new Map();
function rateOk(ip, perMinute) {
  const now = Date.now();
  const cur = apiHits.get(ip);
  if (!cur || now - cur.at >= 60000) {
    if (apiHits.size > 4000) {
      for (const [k, v] of apiHits) if (now - v.at >= 120000) apiHits.delete(k);
    }
    apiHits.set(ip, { n: 1, at: now });
    return true;
  }
  cur.n += 1;
  return cur.n <= perMinute;
}

function siteFromReferer(request) {
  const ref = request.headers.get('Referer') || request.headers.get('Referrer') || '';
  if (!ref) return '';
  try {
    const u = new URL(ref);
    const first = u.pathname.split('/').filter(Boolean)[0] || '';
    let id = first;
    try {
      id = decodeURIComponent(first);
    } catch {
      /* 原样用 */
    }
    if (!id || RESERVED.has(id.toLowerCase())) return '';
    return id;
  } catch {
    return '';
  }
}

function queryObject(url) {
  const out = {};
  for (const [k, v] of url.searchParams) out[k] = v;
  return out;
}

async function readJsonBody(request) {
  const t = await request.text();
  if (!t || t.length > 256 * 1024) return {};
  try {
    const v = JSON.parse(t);
    if (v && typeof v === 'object') return v;
    return { value: v };
  } catch {
    return { value: t.slice(0, 2000) };
  }
}

function publicHeaders(request) {
  const out = {};
  request.headers.forEach((v, k) => {
    const lk = k.toLowerCase();
    if (lk === 'cookie') return;
    out[lk] = v;
  });
  return out;
}
