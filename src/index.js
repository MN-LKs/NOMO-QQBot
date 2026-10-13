import { loadConfig, ALL_VARS, REQUIRED_VARS } from './config.js';
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
      if (path === '/health' || path === '/healthz') {
        return json({ ok: true, service: 'npapi', ts: Date.now() });
      }

      if (path === '/favicon.ico') {
        return new Response(null, { status: 204 });
      }

      if (path === '/check') {
        return await selfCheck(env, cfg, url);
      }

      if (path === cfg.webhookPath || path.startsWith(`${cfg.webhookPath}/`)) {
        return await handleWebhook(request, cfg, env);
      }

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

async function selfCheck(env, cfg, url) {
  const checks = [];
  const notes = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  add('QQ_APP_ID', !!cfg.appId, cfg.appId ? '已设置' : '未设置 ← 必填');
  add('QQ_APP_SECRET', !!cfg.appSecret, cfg.appSecret ? mask(cfg.appSecret) : '未设置 ← 必填');
  add('LLM_BASE_URL', !!cfg.llmBaseUrl, cfg.llmBaseUrl || '未设置 ← 必填,例如 https://api.example.com/v1');
  add('LLM_API_KEY', !!cfg.llmApiKey, cfg.llmApiKey ? mask(cfg.llmApiKey) : '未设置 ← 必填');
  add('SEARCH_API_URL', true, cfg.searchApiUrl ? `已设置(${cfg.searchApiUrl})` : '未设置 → 联网搜索不可用');
  add('SEARCH_API_KEY', true, cfg.searchApiKey ? '已设置' : '未设置 → 联网搜索不可用');
  add('PUBLIC_BASE_URL', true, cfg.publicBaseUrl || '未设置 → 部署链接只返回相对路径');

  add('模型', true, `${cfg.llmModel}(思考 ${cfg.reasoningEffort})`);
  add('输出上限', true, '不限制(请求不带 max_tokens)');
  add('部署名额 / 存活', true, `${cfg.maxSites} 个 / ${Math.round(cfg.siteTtlSeconds / 60)} 分钟`);
  add('部署 ID', true, `${cfg.idLen} 位 ${cfg.idCharset}`);

  const hook = `${url.protocol}//${url.host}${cfg.webhookPath}`;
  add('回调地址(填到 QQ 开放平台)', true, hook);

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

  const missing = REQUIRED_VARS.filter((k) => !String(env?.[k] ?? '').trim());
  if (missing.length) notes.push(`还缺必填变量:${missing.join(' / ')}`);

  if (url.searchParams.get('live') === '1') {
    try {
      const res = await fetch(`${cfg.llmBaseUrl}/models`, {
        headers: { 'Authorization': `Bearer ${cfg.llmApiKey}`, 'User-Agent': 'NPAPI/1.0' },
      });
      add('大模型网关连通', res.ok, `HTTP ${res.status}`);
    } catch (e) {
      add('大模型网关连通', false, String(e?.message || e));
    }
    try {
      const stub = env.BOT_CORE.get(env.BOT_CORE.idFromName('core'));
      await (await stub.fetch('https://do/tick')).text();
      add('Durable Object 闹钟', true, '已触发一次');
    } catch (e) {
      add('Durable Object 闹钟', false, String(e?.message || e));
    }
  }

  const ok = checks.every((c) => c.ok);
  return new Response(JSON.stringify({
    ok,
    variables: ALL_VARS,
    checks,
    notes,
    hint: '带 ?live=1 会真的调一次上游网关',
  }, null, 2), {
    status: ok ? 200 : 500,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
