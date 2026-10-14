import { getProject, listFiles, bumpHits, dataGet, dataSet } from './store/projects.js';
import { getFile, mimeFor } from './store/kvfile.js';
import { bump, bumpDaily } from './store/stats.js';

let pending = new Map();
let pendingVisits = 0;
let lastFlush = 0;

export function splitSitePath(pathname) {
  const parts = String(pathname || '').split('/').filter(Boolean);
  if (!parts.length) return { id: '', rest: '' };
  return { id: parts[0], rest: parts.slice(1).join('/') };
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

function page(title, msg, status = 404) {
  return new Response(
    `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${title}</title><style>body{font:15px/1.7 -apple-system,"PingFang SC",sans-serif;display:flex;align-items:center;`
    + `justify-content:center;min-height:100vh;margin:0;background:#0f172a;color:#e2e8f0}div{text-align:center;padding:30px}`
    + `b{font-size:17px}h1{font-size:52px;margin:0 0 8px;color:#3b82f6}p{color:#94a3b8;font-size:13px}</style></head>`
    + `<body><div><h1>404</h1><b>${msg}</b><p>这个页面由 NPAPI 临时部署,到期会自动销毁</p></div></body></html>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
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
  const files = await listFiles(env, id);
  const meta = files.find((f) => f.path === filePath);
  if (!meta) {
    if (!rest) return page('404', '这个项目还没有 index.html');
    return page('404', `找不到文件 ${filePath}`);
  }

  const bytes = await getFile(env, id, meta.path, meta.gz);
  if (!bytes) return page('404', '文件内容已丢失');

  if (!rest || /\.html?$/.test(meta.path)) noteView(env, ctx, id);

  const headers = {
    'Content-Type': meta.ct || mimeFor(meta.path),
    'Cache-Control': 'public, max-age=60',
    'X-Content-Type-Options': 'nosniff',
  };
  if (request.method === 'HEAD') return new Response(null, { headers });
  return new Response(bytes, { headers });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
