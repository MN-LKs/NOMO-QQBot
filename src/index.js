// Cloudflare Workers 入口。
//
// 路由表:
//   POST /qq/webhook[/<口令>]   QQ 开放平台的事件回调(在开放平台后台填这个地址)
//   GET  /health                存活探针
//   GET  /check                 自检页(排查问题先看这里)
//   GET  /admin/status?token=   运行状态(需要 ADMIN_TOKEN)
//   GET  /<8字符ID>[/路径]      AI 部署出来的网页
//
// 注意:整个 Worker 的 CPU 预算在免费套餐只有 10 ms/请求,
// 所以这里只做「验签 + 丢给 Durable Object + 返回」,重活全在 DO 的闹钟里干。

import { loadConfig } from './config.js';
import { handleWebhook } from './qq/webhook.js';
import { serveSite, splitSitePath } from './serve.js';
import { BotCore } from './core/do.js';
import { isReservedPath } from './util/id.js';

export { BotCore };

export default {
  async fetch(request, env, ctx) {
    const cfg = loadConfig(env);
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // ---------- 探针 ----------
      if (path === '/health' || path === '/healthz') {
        return json({ ok: true, service: 'qqbot-nb-api', ts: Date.now() });
      }

      if (path === '/favicon.ico') {
        return new Response(null, { status: 204 });
      }

      // ---------- 自检 ----------
      if (path === '/check') {
        return await selfCheck(request, env, cfg, url);
      }

      // ---------- 管理(需要 ADMIN_TOKEN)----------
      if (path.startsWith('/admin/')) {
        if (!cfg.adminToken) return json({ error: '未设置 ADMIN_TOKEN,该功能已关闭' }, 403);
        if (url.searchParams.get('token') !== cfg.adminToken) return json({ error: 'token 不对' }, 403);

        const stub = env.BOT_CORE.get(env.BOT_CORE.idFromName('core'));
        if (path === '/admin/status') {
          const r = await stub.fetch('https://do/status');
          return json(await r.json());
        }
        if (path === '/admin/sites') {
          const r = await stub.fetch('https://do/site/list');
          const d = await r.json();
          const now = Date.now();
          return json({
            count: d.sites.length,
            max: cfg.maxSites,
            sites: d.sites.map((s) => ({
              id: s.id,
              name: s.name,
              url: s.url,
              files: s.files.map((f) => f.path),
              bytes: s.bytes,
              expiresInSeconds: Math.max(0, Math.round((s.expiresAt - now) / 1000)),
              updatedAt: new Date(s.updatedAt).toISOString(),
            })),
          });
        }
        if (path === '/admin/delete') {
          const id = url.searchParams.get('id');
          if (!id) return json({ error: '缺少 id' }, 400);
          const r = await stub.fetch('https://do/site/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id }),
          });
          return json(await r.json());
        }
        if (path === '/admin/clear-context') {
          const convId = url.searchParams.get('conv');
          if (!convId) return json({ error: '缺少 conv' }, 400);
          const r = await stub.fetch('https://do/context/clear', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ convId }),
          });
          return json(await r.json());
        }
        return json({ error: '未知管理接口', hint: '/admin/status | /admin/sites | /admin/delete?id= | /admin/clear-context?conv=' }, 404);
      }

      // ---------- QQ 回调 ----------
      if (path === cfg.webhookPath || path.startsWith(`${cfg.webhookPath}/`)) {
        const rest = path.slice(cfg.webhookPath.length).replace(/^\/+/, '');
        if (cfg.webhookSecret && rest !== cfg.webhookSecret) {
          return json({ error: 'not found' }, 404);
        }
        return await handleWebhook(request, cfg, env);
      }

      // ---------- AI 部署的网页 ----------
      const { id } = splitSitePath(path);
      if (!id || !isReservedPath(id)) {
        const res = await serveSite(env, cfg, request, url);
        if (res) return res;
      }

      return json({ error: 'not found', path }, 404);
    } catch (e) {
      console.error('[worker] 未捕获异常', e?.stack || e);
      return json({ error: 'internal error', message: String(e?.message || e) }, 500);
    }
  },

  // 兜底定时任务:清过期部署、唤醒闹钟
  async scheduled(_event, env, ctx) {
    try {
      const stub = env.BOT_CORE.get(env.BOT_CORE.idFromName('core'));
      ctx.waitUntil(stub.fetch('https://do/tick').then((r) => r.text()).catch(() => null));
    } catch (e) {
      console.error('[cron]', e?.stack || e);
    }
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function mask(s) {
  const v = String(s || '');
  if (!v) return '';
  if (v.length <= 8) return '***';
  return `${v.slice(0, 4)}…${v.slice(-4)}(${v.length}位)`;
}

/**
 * 自检。浏览器直接打开 /check 就能看到哪里没配好。
 * 加 ?live=1 会真的去调一次腾讯接口和大模型(会花一点额度)。
 */
async function selfCheck(request, env, cfg, url) {
  const checks = [];
  const softs = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  const soft = (name, ok, detail) => softs.push({ name, ok, detail });

  // 缺一项就标红并列出名字,别让人猜
  const missing = [];
  const req = (name, ok, detail) => {
    if (!ok) missing.push(name);
    add(name, ok, detail);
  };

  req('QQ_APP_ID', !!cfg.appId, cfg.appId ? '已设置' : '未设置 ← 去 Cloudflare 后台填');
  req('QQ_APP_SECRET', !!cfg.appSecret, cfg.appSecret ? mask(cfg.appSecret) : '未设置 ← 敏感项请用 Secret 类型');
  req('LLM_BASE_URL', !!cfg.llmBaseUrl, cfg.llmBaseUrl || '未设置 ← 例如 https://api.example.com/v1');
  req('LLM_API_KEY', !!cfg.llmApiKey, cfg.llmApiKey ? mask(cfg.llmApiKey) : '未设置 ← 敏感项请用 Secret 类型');
  req('LLM_MODEL', !!cfg.llmModel, cfg.llmModel || '未设置');
  add('深度思考等级', !!cfg.reasoningEffort, cfg.reasoningEffort);
  add('输出上限', true, cfg.maxTokens > 0 ? `${cfg.maxTokens} tokens` : '不限制(请求不带 max_tokens,推荐)');
  add('回调口令 WEBHOOK_SECRET', !!cfg.webhookSecret, cfg.webhookSecret ? '已设置' : '未设置(建议设置)');
  add('验签开关', true, cfg.verifySignature ? '开启(推荐)' : '关闭');
  add('部署域名 PUBLIC_BASE_URL', !!cfg.publicBaseUrl,
    cfg.publicBaseUrl || '未配置 ← 部署链接只会是相对路径,打不开');
  soft('用量查询 DASHBOARD_URL', !!cfg.dashboardUrl,
    cfg.dashboardUrl ? '已配置' : '未配置 → query_dashboard 工具不可用');
  add('部署名额 / 存活', true, `${cfg.maxSites} 个 / ${Math.round(cfg.siteTtlSeconds / 60)} 分钟`);
  add('ID 字符集', true, cfg.idCharset);
  if (missing.length) {
    soft('还缺这些变量', false, `${missing.join(' / ')} ← 到 Workers → Settings → Variables and Secrets 填`);
  }

  const host = url.host;
  const hook = `${url.protocol}//${host}${cfg.webhookPath}${cfg.webhookSecret ? `/${cfg.webhookSecret}` : ''}`;
  add('回调地址(填到开放平台)', true, hook);

  // DO 连通性
  let doOk = false;
  let doDetail = '';
  try {
    const stub = env.BOT_CORE.get(env.BOT_CORE.idFromName('core'));
    const r = await stub.fetch('https://do/status');
    const d = await r.json();
    doOk = true;
    doDetail = `在线部署 ${d.sites} 个,队列 ${d.pending} 待处理`;
  } catch (e) {
    doDetail = String(e?.message || e);
  }
  add('Durable Object', doOk, doDetail);

  if (url.searchParams.get('live') === '1') {
    // 腾讯 access_token
    try {
      const stub = env.BOT_CORE.get(env.BOT_CORE.idFromName('core'));
      const r = await stub.fetch('https://do/tick');
      await r.text();
      add('Durable Object 闹钟', true, '已触发一次');
    } catch (e) {
      add('Durable Object 闹钟', false, String(e?.message || e));
    }

    try {
      const res = await fetch(`${cfg.llmBaseUrl}/models`, {
        headers: { 'Authorization': `Bearer ${cfg.llmApiKey}`, 'User-Agent': 'QQBot-NB-API/1.0' },
      });
      add('大模型网关连通', res.ok, `HTTP ${res.status}`);
    } catch (e) {
      add('大模型网关连通', false, String(e?.message || e));
    }
  }

  const ok = checks.every((c) => c.ok);
  return new Response(JSON.stringify({ ok, checks, suggestions: softs, hint: '加 ?live=1 可做联网测试' }, null, 2), {
    status: ok ? 200 : 500,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
