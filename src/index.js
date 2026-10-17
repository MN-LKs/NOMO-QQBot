import { loadEnv, missingEnv, FIXED } from './config.js';
import { loadCfg, getRaw } from './store/settings.js';
import { handleWebhook } from './qq/webhook.js';
import { serveSite, splitSitePath, page, handleSiteApi, RESERVED } from './serve.js';
import { isSiteId } from './util/id.js';
import { BotCore } from './core/do.js';
import { handlePanelApi, jsonRes } from './panel/api.js';
import { loginPage, panelPage } from './panel/ui.js';
import { isAuthed, checkCredentials, issue, cookieHeader, clearCookieHeader, readCookie, lockedFor, noteFail, clearFail, sameOrigin } from './panel/auth.js';
import { write as logWrite } from './store/logs.js';
import { ensureSchema } from './store/db.js';
import { ensureDetected } from './store/storage.js';

export { BotCore };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      const missing = missingEnv(env);
      if (path === FIXED.panelPath || path.startsWith(`${FIXED.panelPath}/`)) {
        return await panel(request, env, url, missing);
      }

      if (missing.length) {
        return html(`<h2 style="font:16px sans-serif;padding:40px">还没有配置管理员账号,请在 Cloudflare 后台添加环境变量:${missing.join(' / ')}</h2>`, 503);
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

function html(body, status = 200, extra = {}) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
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
    return html(loginPage({ hint: missing.length ? `还缺少环境变量:${missing.join(' / ')}` : '' }));
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
  return html(panelPage({ user: env.ADMIN_USER }));
}
