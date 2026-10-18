import { CSP_PANEL } from '../config.js';

/**
 * 站点首页。
 * 公开页面,不依赖 D1/KV;即使面板还没配置好也能打开。
 * 纯 CSS 动效,不引外部资源,符合面板 CSP。
 */
export function homePage(settings = null) {
  const hp = settings?.ui?.homepage || {};
  const title = String(hp.title || 'NOMO');
  const subtitle = String(hp.subtitle || 'QQ 群聊 · AI 助手');
  const description = String(hp.description || 'NOMO 是一个跑在 Cloudflare Workers 上的 QQ 机器人。它能聊天、能搜索、能调用工具,还能在群里直接生成并部署一个临时网页。没有服务器,没有常驻进程,闲时自动休眠。');
  const github = String(hp.github || 'https://github.com/MN-LKs/NOMO-QQBot');
  const siteBase = String(settings?.site?.publicBaseUrl || 'https://example.com').replace(/\/$/, '');
  const demoUrl = `${siteBase}/xxxxxxxx`;
  const showGithub = hp.showGithub !== false;
  const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  if (hp.enabled === false) {
    return new Response('首页未启用', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
  if (hp.custom === true && String(hp.html || '').trim()) {
    return new Response(String(hp.html), {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#070b14">
<meta name="description" content="${esc(description)}">
<title>${esc(title)} · 群聊里的 AI 助手</title>
<style>
:root{--bg:#070b14;--text:#eaf0ff;--dim:#93a4c4;--line:rgba(255,255,255,.12);--accent:#6ea8ff;--accent2:#a78bfa}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{font:15px/1.75 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;color:var(--text);
 background:radial-gradient(1100px 760px at 12% -12%,#16305e 0%,transparent 58%),
 radial-gradient(900px 680px at 112% 18%,#3b1d63 0%,transparent 52%),var(--bg);overflow-x:hidden}
a{color:inherit;text-decoration:none}
.orb{position:fixed;border-radius:50%;filter:blur(46px);opacity:.45;pointer-events:none;animation:float 16s ease-in-out infinite}
.orb.a{width:340px;height:340px;background:#2563eb;left:-90px;top:8%}
.orb.b{width:300px;height:300px;background:#7c3aed;right:-80px;top:26%;animation-delay:-5s}
.orb.c{width:240px;height:240px;background:#0891b2;left:38%;bottom:-120px;animation-delay:-9s}
@keyframes float{0%,100%{transform:translate3d(0,0,0) scale(1)}50%{transform:translate3d(18px,-26px,0) scale(1.08)}}
.wrap{position:relative;z-index:1;max-width:1120px;margin:0 auto;padding:28px 22px 64px}
.top{display:flex;align-items:center;gap:12px}
.brand{display:flex;align-items:center;gap:10px;font-weight:800;letter-spacing:.02em}
.brand .mark{width:38px;height:38px;border-radius:12px;display:grid;place-items:center;
 background:linear-gradient(145deg,#2f6df6,#8b5cf6);box-shadow:0 10px 30px rgba(59,130,246,.35)}
.brand .mark svg{width:21px;height:21px}
.sp{flex:1}
.pill{display:inline-flex;align-items:center;gap:7px;padding:7px 12px;border:1px solid var(--line);border-radius:999px;
 background:rgba(255,255,255,.05);color:var(--dim);font-size:12.5px;backdrop-filter:blur(10px)}
.dot{width:7px;height:7px;border-radius:50%;background:#34d399;box-shadow:0 0 0 0 rgba(52,211,153,.7);animation:pulse 2s infinite}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(52,211,153,.55)}70%{box-shadow:0 0 0 9px rgba(52,211,153,0)}100%{box-shadow:0 0 0 0 rgba(52,211,153,0)}}
.hero{margin-top:76px;display:grid;grid-template-columns:1.15fr .85fr;gap:34px;align-items:center}
.eyebrow{display:inline-flex;align-items:center;gap:8px;padding:6px 11px;border-radius:999px;border:1px solid rgba(110,168,255,.28);
 background:rgba(110,168,255,.09);color:#bcd4ff;font-size:12.5px;letter-spacing:.06em}
h1{margin:18px 0 16px;font-size:clamp(38px,6vw,66px);line-height:1.06;letter-spacing:-.03em}
h1 .g{background:linear-gradient(110deg,#dbeafe 5%,#8bb8ff 38%,#c4b5fd 72%,#f0abfc 100%);
 -webkit-background-clip:text;background-clip:text;color:transparent}
.lead{max-width:560px;color:var(--dim);font-size:16px;line-height:1.9}
.actions{display:flex;flex-wrap:wrap;gap:12px;margin-top:28px}
.btn{display:inline-flex;align-items:center;gap:9px;padding:13px 19px;border-radius:14px;font-weight:650;font-size:14px;
 border:1px solid var(--line);transition:transform .2s ease,box-shadow .2s ease,background .2s ease}
.btn:hover{transform:translateY(-2px)}
.btn.primary{background:linear-gradient(135deg,#2f6df6,#7c3aed);border-color:transparent;box-shadow:0 14px 34px rgba(79,70,229,.38)}
.btn.primary:hover{box-shadow:0 18px 44px rgba(79,70,229,.5)}
.btn.ghost{background:rgba(255,255,255,.05);backdrop-filter:blur(10px)}
.btn svg{width:17px;height:17px}
.glass{background:linear-gradient(145deg,rgba(255,255,255,.10),rgba(255,255,255,.028));
 border:1px solid var(--line);border-radius:26px;backdrop-filter:blur(18px);box-shadow:0 30px 80px rgba(0,0,0,.42)}
.terminal{padding:18px;transform:rotate(1.2deg);animation:rise .9s .15s ease both}
.terminal .bar{display:flex;gap:6px;margin-bottom:14px}
.terminal .bar i{width:9px;height:9px;border-radius:50%;background:#334155}
.terminal .bar i:nth-child(1){background:#f87171}.terminal .bar i:nth-child(2){background:#fbbf24}.terminal .bar i:nth-child(3){background:#34d399}
.msg{display:flex;gap:10px;margin:12px 0;opacity:0;animation:rise .7s ease forwards}
.msg.u{animation-delay:.45s}.msg.b{animation-delay:.85s}.msg.t{animation-delay:1.25s}
.avatar{width:30px;height:30px;border-radius:10px;flex:0 0 30px;display:grid;place-items:center;font-size:12px;font-weight:800}
.avatar.u{background:#1e293b;color:#cbd5e1}.avatar.b{background:linear-gradient(145deg,#2f6df6,#8b5cf6);color:#fff}
.bubble{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:9px 12px;
 color:#dbe7ff;font-size:12.8px;line-height:1.65}
.bubble .tag{display:inline-block;margin-top:6px;padding:2px 7px;border-radius:6px;background:rgba(110,168,255,.14);
 color:#9cc4ff;font-size:11px;border:1px solid rgba(110,168,255,.2)}
@keyframes rise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:translateY(0)}}
.features{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-top:56px}
.feat{padding:18px;border-radius:18px;border:1px solid var(--line);background:rgba(255,255,255,.035);
 transition:transform .25s ease,background .25s ease,border-color .25s ease}
.feat:hover{transform:translateY(-4px);background:rgba(255,255,255,.06);border-color:rgba(110,168,255,.3)}
.feat .ic{width:34px;height:34px;border-radius:11px;display:grid;place-items:center;background:rgba(110,168,255,.12);color:#9cc4ff;margin-bottom:12px}
.feat .ic svg{width:18px;height:18px}
.feat b{display:block;font-size:14px;margin-bottom:5px}
.feat span{display:block;color:var(--dim);font-size:12.5px;line-height:1.65}
.foot{margin-top:52px;display:flex;flex-wrap:wrap;gap:12px;align-items:center;color:#64748b;font-size:12.5px}
.foot .sp{flex:1}
.foot a{color:#93a4c4}.foot a:hover{color:#dbeafe}
@media(max-width:900px){.hero{grid-template-columns:1fr;margin-top:48px}.terminal{transform:none;max-width:520px}.features{grid-template-columns:repeat(2,1fr)}}
@media(max-width:520px){.wrap{padding:20px 16px 48px}.features{grid-template-columns:1fr}.actions .btn{flex:1;justify-content:center}h1{font-size:40px}}
</style>
</head>
<body>
<div class="orb a"></div><div class="orb b"></div><div class="orb c"></div>
<div class="wrap">
  <header class="top">
    <div class="brand">
      <span class="mark"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linejoin="round"><path d="M12 2 2 7l10 5 10-5-10-5Z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg></span>
      <span>${esc(title)}</span>
    </div>
    <div class="sp"></div>
    <span class="pill"><i class="dot"></i>Cloudflare Workers</span>
  </header>

  <section class="hero">
    <div>
      <span class="eyebrow">${esc(subtitle)}</span>
      <h1>把 AI 放进群聊,<br><span class="g">也把工具交给它。</span></h1>
      <p class="lead">${esc(description)}</p>
      <div class="actions">
        <a class="btn primary" href="${esc(github)}" target="_blank" rel="noopener" style="display:${showGithub ? 'inline-flex' : 'none'}">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 .5C5.7.5.5 5.7.5 12c0 5.1 3.3 9.4 7.9 10.9.6.1.8-.2.8-.6v-2.2c-3.2.7-3.9-1.4-3.9-1.4-.5-1.3-1.3-1.7-1.3-1.7-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.7 1.3 3.4 1 .1-.8.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.8 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.6 1.6.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.5-2.7 5.5-5.3 5.8.4.4.8 1.1.8 2.2v3.3c0 .4.2.7.8.6A11.5 11.5 0 0 0 23.5 12C23.5 5.7 18.3.5 12 .5Z"/></svg>
          GitHub 仓库
        </a>
        <a class="btn ghost" href="/administrator">进入管理面板</a>
      </div>
    </div>

    <div class="glass terminal" aria-hidden="true">
      <div class="bar"><i></i><i></i><i></i></div>
      <div class="msg u"><span class="avatar u">你</span><div class="bubble">/AI 帮我查一下这周的天气,再做个页面</div></div>
      <div class="msg b"><span class="avatar b">N</span><div class="bubble">收到,我先查天气,再把结果做成一个可以直接打开的页面。<br><span class="tag">工具调用 · search_web</span></div></div>
      <div class="msg t"><span class="avatar b">N</span><div class="bubble">页面已经部署好了:<br><span style="color:#9cc4ff">${esc(demoUrl)}</span><br><span class="tag">存活 10 分钟 · 自动销毁</span></div></div>
    </div>
  </section>

  <section class="features">
    <div class="feat"><div class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.7 8.7 0 0 1-3.8-.9L3 21l1.9-4.2A8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5Z"/></svg></div><b>群聊对话</b><span>@ 或 /AI 直接提问,支持上下文、记忆和自动压缩。</span></div>
    <div class="feat"><div class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.1-2.1 2.6-2.6Z"/></svg></div><b>工具调用</b><span>搜索、时间、代码执行、群聊查询,模型自己决定用哪个。</span></div>
    <div class="feat"><div class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 4h16v16H4z"/><path d="M8 9h8M8 13h8M8 17h5"/></svg></div><b>临时部署</b><span>一句话生成网页,自动分配链接,到期自动销毁。</span></div>
    <div class="feat"><div class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3 4 7v6c0 4.4 3.4 8.5 8 9 4.6-.5 8-4.6 8-9V7l-8-4Z"/><path d="m9 12 2 2 4-4"/></svg></div><b>可控权限</b><span>群白名单、管理员、主动/被动投递,配置都在面板里。</span></div>
  </section>

  <footer class="foot">
    <span>${esc(title)} · Cloudflare Workers</span>
    <span class="sp"></span>
    <a href="${esc(github)}" target="_blank" rel="noopener" style="display:${showGithub ? 'inline' : 'none'}">GitHub</a>
    <a href="/administrator">管理面板</a>
  </footer>
</div>
</body>
</html>`;
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=60',
      'Content-Security-Policy': CSP_PANEL,
      'X-Frame-Options': 'DENY',
    },
  });
}
