import { loadEnv, missingEnv, missingStorage, FIXED, CSP_PANEL } from './config.js';
import { loadCfg, getRaw } from './store/settings.js';
import { handleWebhook } from './qq/webhook.js';
import { serveSite, splitSitePath, page, handleSiteApi, serveMedia, RESERVED } from './serve.js';
import { isSiteId } from './util/id.js';
import { BotCore } from './core/do.js';
import { execBackend, normalizeBackendResult } from './core/backend.js';
import { handlePanelApi, jsonRes } from './panel/api.js';
import { loginPage, panelPage, lockedPage } from './panel/ui.js';
import { homePage } from './panel/home.js';
import { confirmPage } from './panel/confirm.js';
import { isAuthed, checkCredentials, issue, cookieHeader, clearCookieHeader, readCookie, lockedFor, noteFail, clearFail, sameOrigin } from './panel/auth.js';
import { write as logWrite } from './store/logs.js';
import { ensureSchema } from './store/db.js';
import { ensureDetected } from './store/storage.js';

export { BotCore };

async function handleFetch(request, env, ctx) {
  const url = new URL(request.url);
    const path = url.pathname;

    try {
      const missing = missingEnv(env);
      if (path === FIXED.panelPath || path.startsWith(`${FIXED.panelPath}/`)) {
        return await panel(request, env, url, missing);
      }

      // 公开首页:不依赖管理员变量/D1/KV,先于 503 守卫返回。
      if (path === '/') {
        const settings = await getRaw(env).catch(() => null);
        return homePage(settings);
      }

      if (missing.length) {
        return page('503', '服务还没有初始化完成:管理员账号未设置,面板登录已关闭', 503,
          '请在 Cloudflare 后台配置 ADMIN_USER / ADMIN_PASS 两个环境变量,然后刷新本页');
      }

      if (path.startsWith('/confirm/')) {
        if (!env.BOT_CORE) return page('404', '确认功能未启用');
        const token = decodeURIComponent(path.slice('/confirm/'.length));
        const stub = env.BOT_CORE.get(env.BOT_CORE.idFromName('core'));
        if (request.method === 'POST') {
          const form = await request.formData().catch(() => null);
          const action = form?.get('action');
          const r = await stub.fetch('https://do/pending/resolve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, approve: action === 'approve' }),
          });
          const data = await r.json().catch(() => ({ error: '确认失败' }));
          return html(confirmPage({ token, result: data, error: data.error || '' }));
        }
        const r = await stub.fetch('https://do/pending/get', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        const pending = await r.json().catch(() => null);
        return html(confirmPage({ token, pending }));
      }

      // 搜索引擎和扫描器都会来要这个文件;顺手告诉它们别碰管理面板
      if (path === '/robots.txt') {
        return new Response('User-agent: *\nAllow: /\nDisallow: /administrator\n', {
          headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' },
        });
      }

      if (path === '/favicon.ico') return new Response(null, { status: 204 });

      const cfg = await loadCfg(env);

      if (path === cfg.webhookPath || path.startsWith(`${cfg.webhookPath}/`)) {
        if (cfg.mode !== 'webhook') return jsonRes({ error: '当前是 WebSocket 模式,回调地址未启用' }, 403);
        return await handleWebhook(request, cfg, env);
      }

      if (path === '/api' || path.startsWith('/api/')) {
        if (!env.DB || !env.STORE) return notReady(env);
        return await handleSiteApi(env, cfg, request, url);
      }

      if (path.startsWith('/media/')) {
        return await serveMedia(env, request, url);
      }

      if (path.startsWith('/home-api/')) {
        return await handleHomeApi(env, request, url);
      }

      const { id } = splitSitePath(path);
      if (id && !RESERVED.has(id.toLowerCase())) {
        // 扫描器天天在找 /env.dev、/.env 这类文件:形状不对的直接 404,不去碰数据库
        if (!isSiteId(id)) return page('404', '这个地址没有对应的页面');
        if (!env.DB || !env.STORE) return notReady(env);
        return await serveSite(env, cfg, request, url, ctx);
      }

      return page('404', '这个地址没有对应的页面');
    } catch (e) {
      await logWrite(env, 'error', 'worker', `未捕获异常 ${path}:${e?.stack || e}`).catch(() => null);
      return new Response('Internal Error', { status: 500 });
    }
}

const SECURITY_HEADERS = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(self), microphone=(self), geolocation=(self)',
};

// 所有响应统一补安全头;页面自己设过的(比如部署页面)不覆盖
function withSecurityHeaders(res) {
  if (!res || res.status === 101 || res.webSocket) return res;
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    if (!headers.has(k)) headers.set(k, v);
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export default {
  async fetch(request, env, ctx) {
    return withSecurityHeaders(await handleFetch(request, env, ctx));
  },

  async scheduled(_event, env, ctx) {
    try {
      if (!env?.BOT_CORE) return;
      const stub = env.BOT_CORE.get(env.BOT_CORE.idFromName('core'));
      ctx.waitUntil(stub.fetch('https://do/tick', { method: 'POST' }).then((r) => r.text()).catch(() => null));
    } catch {
      /* ignore */
    }
  },
};

// 自定义首页后端:由管理员在「首页配置」里写 JS,沙盒执行 /home-api/*
async function handleHomeApi(env, request, url) {
  if (request.method !== 'GET' && request.method !== 'POST') {
    return jsonRes({ error: '只支持 GET / POST' }, 405);
  }
  const settings = await getRaw(env).catch(() => null);
  const code = String(settings?.ui?.homepage?.backend || '').trim();
  if (!code) return jsonRes({ error: '首页后端还没有配置' }, 404);
  const body = request.method === 'POST' ? await request.text() : '';
  if (body.length > 256 * 1024) return jsonRes({ error: '请求体太大' }, 413);
  const r = await execBackend(code, {
    method: request.method,
    path: url.pathname.replace(/^\/home-api\/?/, ''),
    query: Object.fromEntries(url.searchParams),
    body,
    json: () => JSON.parse(body || '{}'),
    fetch: (u, init) => fetch(u, init),
    now: () => Date.now(),
  }, { timeoutMs: 5000 });
  if (!r.ok) return jsonRes({ error: `首页后端执行失败:${r.error}` }, 500);
  const out = normalizeBackendResult(r.value);
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

function html(body, status = 200, extra = {}) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': CSP_PANEL,
      'X-Frame-Options': 'DENY',
      ...extra,
    },
  });
}

// D1 / KV 还没绑定时,给一句人话,而不是一个看不懂的 500
function notReady(env) {
  const miss = [];
  if (!env.DB) miss.push('D1 数据库(变量名填 DB)');
  if (!env.STORE) miss.push('KV 命名空间(变量名填 STORE)');
  return page('503', `部署服务还没就绪,请先在 Cloudflare 后台绑定:${miss.join('、')}`, 503, '绑定完成后重新访问这个地址即可');
}

async function panel(request, env, url, missing) {
  const path = url.pathname;

  // 管理员账号没配置:登录功能直接关闭,不再摆一个「缺变量」的登录表单
  if (missing.length) {
    if (path.startsWith(`${FIXED.panelPath}/api/`)) {
      return jsonRes({ error: '登录功能已关闭' }, 403);
    }
    return html(lockedPage());
  }

  // D1 / KV 没绑定时不再直接锁死面板:允许用管理员账号登录,
  // 页面会显示缺什么配置;依赖 D1/KV 的接口会返回明确错误。
  const noStore = missingStorage(env);

  if (path === `${FIXED.panelPath}/api/login`) {
    if (request.method !== 'POST') return jsonRes({ error: '只接受 POST' }, 405);
    if (!sameOrigin(request)) return jsonRes({ error: '来源不合法' }, 403);
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const lock = await lockedFor(env, ip);
    if (lock > 0) {
      return jsonRes({ error: `尝试次数过多,请 ${Math.ceil(lock / 60000)} 分钟后再试` }, 429);
    }
    let body = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }
    if (!checkCredentials(env, body.user, body.pass)) {
      const r = await noteFail(env, ip);
      await logWrite(env, 'warn', 'panel', `登录失败 ip=${ip} 累计 ${r.fails} 次`);
      const left = Math.max(0, FIXED.loginMaxFails - r.fails);
      return jsonRes({ error: left > 0 ? `用户名或密码不对(还剩 ${left} 次机会)` : '尝试次数过多,已临时锁定 15 分钟' }, 401);
    }
    await clearFail(env, ip);
    await logWrite(env, 'info', 'panel', `管理员登录成功 ip=${ip}`);
    // 登录时自动检测存储绑定:绑了 R2 就补进配置并设为主存储(失败不挡登录)
    if (env?.DB) {
      try {
        await ensureDetected(env);
      } catch {
        /* ignore */
      }
    }
    const token = await issue(env);
    return jsonRes({ ok: true }, 200, { 'Set-Cookie': cookieHeader(token, FIXED.sessionDays * 86400) });
  }

  if (path === `${FIXED.panelPath}/api/logout`) {
    return jsonRes({ ok: true }, 200, { 'Set-Cookie': clearCookieHeader() });
  }

  const authed = await isAuthed(request, env);
  if (!authed) {
    if (path.startsWith(`${FIXED.panelPath}/api/`)) return jsonRes({ error: '未登录' }, 401);
    return html(loginPage());
  }

  if (path.startsWith(`${FIXED.panelPath}/api/`)) {
    if (request.method !== 'GET' && !sameOrigin(request)) return jsonRes({ error: '来源不合法' }, 403);
    if (env?.DB) await ensureSchema(env.DB);
    return await handlePanelApi(request, env, url);
  }

  const settings = await getRaw(env).catch(() => null);
  if (!settings) {
    return html(loginPage({ error: 'D1 数据库没有绑定,请先在 Cloudflare 后台绑定名为 DB 的 D1 数据库' }));
  }
  return html(panelPage({
    user: env.ADMIN_USER,
    version: settings.ui?.panelVersion === 'v2' ? 'v2' : 'v1',
    accent: settings.ui?.accent || 'blue',
    appVersion: FIXED.appVersion,
    checkUpdates: settings.update?.check !== false,
    warnings: noStore.map((x) => `没有绑定 ${x},依赖它的功能暂时不可用。`),
  }));
}
