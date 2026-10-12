// 托管 AI 部署出来的网页。
// URL 形态:https://<域名>/<8字符ID>             -> index.html
//           https://<域名>/<8字符ID>/app.js      -> 指定文件
//           https://<域名>/<8字符ID>/__data/键   -> 内置简易后端(GET 读 / POST 写)

const TYPES = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
  woff: 'font/woff',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  wasm: 'application/wasm',
  xml: 'application/xml; charset=utf-8',
};

function contentType(path) {
  const ext = String(path).split('.').pop()?.toLowerCase() || '';
  return TYPES[ext] || 'application/octet-stream';
}

function securityHeaders(path) {
  const isHtml = /\.html?$/i.test(path) || !path.includes('.');
  const h = new Headers({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow',
    // AI 生成的页面需要内联脚本和外链 CDN,所以给一个宽松但明确的 CSP
    'Content-Security-Policy': "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: https:; "
      + "img-src 'self' data: blob: https:; connect-src 'self' https:;",
    'Cache-Control': isHtml ? 'no-store' : 'public, max-age=30',
  });
  return h;
}

const NOT_FOUND_PAGE = (id) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>项目不存在或已过期</title>
<style>
 body{margin:0;height:100vh;display:grid;place-items:center;background:#0f1115;color:#e6e8ee;
      font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
 .card{max-width:460px;padding:36px 32px;border-radius:18px;background:#171a21;
       box-shadow:0 20px 60px rgba(0,0,0,.5);text-align:center}
 h1{font-size:20px;margin:0 0 10px}
 p{color:#9aa3b2;line-height:1.7;font-size:14px;margin:6px 0}
 code{background:#0f1115;padding:2px 7px;border-radius:6px;color:#7ee0b0}
</style></head><body><div class="card">
<h1>😕 这个项目不在了</h1>
<p>ID <code>${escapeHtml(id)}</code> 对应的部署不存在。</p>
<p>AI 部署的网页默认只存活 10 分钟,到期会自动销毁;<br>
同一时间也最多只保留 6 个,名额满了会淘汰最久没改动的那一个。</p>
<p>回到 QQ 群 @ 机器人重新生成一个吧。</p>
</div></body></html>`;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function textPage(title, msg, status) {
  return new Response(NOT_FOUND_PAGE(title || msg), {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/** 把 pathname 拆成 { id, file } */
export function splitSitePath(pathname) {
  let raw = String(pathname || '/').replace(/^\/+/, '');
  const slash = raw.indexOf('/');
  let id = slash < 0 ? raw : raw.slice(0, slash);
  let file = slash < 0 ? '' : raw.slice(slash + 1);
  try {
    id = decodeURIComponent(id);
  } catch { /* 保持原样 */ }
  try {
    file = decodeURIComponent(file);
  } catch { /* 保持原样 */ }
  return { id, file: file.replace(/^\/+/, '') };
}

export async function serveSite(env, cfg, request, url) {
  const { id, file } = splitSitePath(url.pathname);
  if (!id) return null;

  const stub = env.BOT_CORE.get(env.BOT_CORE.idFromName('core'));

  // ---- 内置后端:./__data/<key> ----
  if (file === '__data' || file.startsWith('__data/')) {
    const key = file.slice('__data'.length).replace(/^\/+/, '');
    if (!key) return json({ error: '缺少键名' }, 400);
    if (request.method === 'GET') {
      const r = await stub.fetch(`https://do/data/get?id=${encodeURIComponent(id)}&key=${encodeURIComponent(key)}`);
      const d = await r.json();
      if (d.value === null || d.value === undefined) return json({ error: 'no such key' }, 404);
      return new Response(d.value, {
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' },
      });
    }
    if (request.method === 'POST' || request.method === 'PUT') {
      const value = await request.text();
      if (value.length > 100000) return json({ error: '值太大' }, 413);
      const r = await stub.fetch('https://do/data/put', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, key, value }),
      });
      const d = await r.json();
      if (d.error) return json(d, 400);
      return json({ ok: true }, 200);
    }
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' },
      });
    }
    return json({ error: '只支持 GET/POST' }, 405);
  }

  // ---- 静态文件 ----
  const r = await stub.fetch(`https://do/site/get?id=${encodeURIComponent(id)}`);
  const { site } = await r.json();
  if (!site) return textPage(id, '', 404);

  let target = file;
  if (!target || target === '' || target.endsWith('/')) target += 'index.html';

  let f = site.files.find((x) => x.path === target);
  if (!f) {
    // 单页应用兜底:找不到文件就回 index.html
    f = site.files.find((x) => x.path.toLowerCase() === 'index.html');
    if (!f) return textPage(id, '', 404);
    target = 'index.html';
  }

  const headers = securityHeaders(target);
  headers.set('Content-Type', contentType(target));
  if (request.method === 'HEAD') return new Response(null, { headers });
  return new Response(f.content, { status: 200, headers });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' },
  });
}
