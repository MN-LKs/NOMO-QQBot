export function loginPage({ error = '', hint = '' } = {}) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="description" content="NOMO-QQBot 管理面板登录页">
<title>登录 · NOMO-QQBot 管理面板</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font:14px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#0f172a;color:#e2e8f0;
display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
.box{width:100%;max-width:380px;background:#1e293b;border:1px solid #334155;border-radius:12px;padding:34px 30px;
box-shadow:0 20px 50px rgba(0,0,0,.45)}
.logo{display:flex;align-items:center;gap:10px;margin-bottom:6px}
.logo b{font-size:19px;letter-spacing:.5px}
.logo span{font-size:12px;color:#64748b}
h1{font-size:15px;font-weight:500;color:#94a3b8;margin:14px 0 22px}
label{display:block;font-size:12px;color:#94a3b8;margin:0 0 6px}
input{width:100%;padding:10px 12px;border-radius:8px;border:1px solid #334155;background:#0f172a;color:#e2e8f0;
font-size:14px;outline:none;transition:.15s}
input:focus{border-color:#3b82f6;box-shadow:0 0 0 3px rgba(59,130,246,.15)}
.field{margin-bottom:16px}
button{width:100%;padding:11px;border:0;border-radius:8px;background:#2563eb;color:#fff;font-size:14px;font-weight:500;
cursor:pointer;transition:.15s}
button:hover{background:#1d4ed8}
button:disabled{opacity:.6;cursor:not-allowed}
.err{background:rgba(220,38,38,.12);border:1px solid rgba(220,38,38,.4);color:#fca5a5;padding:9px 12px;
border-radius:8px;font-size:13px;margin-bottom:16px}
.hint{margin-top:18px;font-size:12px;color:#64748b;line-height:1.7}
</style>
</head>
<body>
<form class="box" id="f">
  <div class="logo"><b>NOMO</b><span>管理面板</span></div>
  <h1>请登录以继续</h1>
  ${error ? `<div class="err">${esc(error)}</div>` : ''}
  <div class="field">
    <label>用户名</label>
    <input name="user" autocomplete="username" autofocus required>
  </div>
  <div class="field">
    <label>密码</label>
    <input name="pass" type="password" autocomplete="current-password" required>
  </div>
  <button type="submit" id="b">登 录</button>
  <div class="hint">${esc(hint || '用户名与密码在 Cloudflare 后台的环境变量 ADMIN_USER / ADMIN_PASS 里设置。')}</div>
</form>
<script>
var f=document.getElementById('f'),b=document.getElementById('b');
f.addEventListener('submit',function(e){
  e.preventDefault();
  b.disabled=true;b.textContent='登录中…';
  fetch('/administrator/api/login',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({user:f.user.value,pass:f.pass.value})})
  .then(function(r){return r.json().then(function(d){return {ok:r.ok,d:d}})})
  .then(function(r){
    if(r.ok&&r.d.ok){location.href='/administrator';return}
    alert(r.d.error||'登录失败');b.disabled=false;b.textContent='登 录';
  })
  .catch(function(){alert('网络错误,请重试');b.disabled=false;b.textContent='登 录'});
});
</script>
</body>
</html>`;
}

// 管理员账号没配置时,面板不显示登录表单,直接锁死并指路 Q&A。
export function lockedPage() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="description" content="NOMO-QQBot 管理面板:登录功能已关闭">
<title>登录功能已关闭 · NOMO-QQBot 管理面板</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font:14px/1.7 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#0f172a;color:#e2e8f0;
display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
.box{width:100%;max-width:420px;background:#1e293b;border:1px solid #334155;border-radius:12px;padding:36px 30px;
box-shadow:0 20px 50px rgba(0,0,0,.45);text-align:center}
.ic{font-size:40px;line-height:1;margin-bottom:14px}
h1{font-size:17px;font-weight:600;margin:0 0 12px}
p{font-size:13px;color:#94a3b8;margin:0 0 10px}
a{color:#60a5fa;font-size:13px;text-decoration:none}
a:hover{text-decoration:underline}
.foot{margin-top:20px;font-size:12px;color:#64748b}
</style>
</head>
<body>
<div class="box">
  <div class="ic">🔒</div>
  <h1>登录功能已关闭</h1>
  <p>这个实例还没有设置管理员账号,面板暂时无法登录。</p>
  <p>在 Cloudflare 后台为本项目配置管理员账号后,刷新本页即可恢复。</p>
  <a href="https://github.com/MN-LKs/NOMO-QQBot/blob/main/docs/FAQ.md" target="_blank" rel="noopener">查看 Q&A:怎么恢复登录 →</a>
  <div class="foot">NOMO-QQBot 管理面板</div>
</div>
</body>
</html>`;
}

export function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function panelPage({ user = '', version = 'v1', accent = 'blue', warnings = [], appVersion = '4.1.0', checkUpdates = true } = {}) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="description" content="NOMO-QQBot 管理面板:机器人、部署项目、存储与日志">
<title>NOMO-QQBot 管理面板</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#f1f5f9;--card:#fff;--line:#e2e8f0;--txt:#0f172a;--dim:#64748b;--pri:#2563eb;--ok:#16a34a;--warn:#d97706;--bad:#dc2626}
body{font:14px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--txt)}
.app{display:flex;min-height:100vh}
aside{width:206px;flex:0 0 206px;background:#1e293b;color:#cbd5e1;display:flex;flex-direction:column;position:fixed;top:0;bottom:0;left:0;z-index:20}
.brand{display:flex;align-items:center;gap:9px;padding:18px 18px 14px;border-bottom:1px solid #334155}
.brand b{color:#fff;font-size:16px;letter-spacing:.5px}
.brand i{font-style:normal;font-size:11px;color:#64748b}
nav{flex:1;padding:10px 0;overflow:auto}
.nav-group{padding:15px 18px 6px;font-size:10.5px;letter-spacing:.1em;color:#64748b;font-weight:700}
.nav{display:flex;align-items:center;gap:10px;padding:11px 18px;cursor:pointer;font-size:13.5px;color:#cbd5e1;
border-left:3px solid transparent;transition:.12s;user-select:none}
.nav:hover{background:#273449;color:#fff}
.nav.on{background:#0f172a;color:#fff;border-left-color:#3b82f6}
.nav svg{width:16px;height:16px;flex:0 0 16px;opacity:.85}
.nav .dot{margin-left:auto;font-size:11px;background:#dc2626;color:#fff;border-radius:9px;padding:0 6px;line-height:16px}
.me{border-top:1px solid #334155;padding:12px 14px;display:flex;align-items:center;gap:10px;cursor:pointer}
.me:hover{background:#273449}
.av{width:34px;height:34px;border-radius:50%;flex:0 0 34px;display:flex;align-items:center;justify-content:center;
font-weight:600;color:#fff;font-size:14px}
.me div{overflow:hidden}
.me p{color:#fff;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.me span{font-size:11px;color:#64748b}
main{flex:1;margin-left:206px;min-width:0}
.top{background:#fff;border-bottom:1px solid var(--line);padding:13px 22px;display:flex;align-items:center;gap:12px;
position:sticky;top:0;z-index:10}
.top h2{font-size:16px;font-weight:600}
.top .sp{flex:1}
.wrap{padding:20px 22px 60px;max-width:1180px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:18px;margin-bottom:16px;
box-shadow:0 1px 2px rgba(15,23,42,.04)}
.card h3{font-size:14px;font-weight:600;margin-bottom:4px;display:flex;align-items:center;gap:8px}
.card .sub{font-size:12px;color:var(--dim);margin-bottom:14px}
.grid{display:grid;gap:14px}
.g5{grid-template-columns:repeat(auto-fit,minmax(168px,1fr))}
.g3{grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}
.g2{grid-template-columns:repeat(auto-fit,minmax(320px,1fr))}
.stat{background:#fff;border:1px solid var(--line);border-radius:10px;padding:15px 16px}
.stat span{font-size:12px;color:var(--dim);display:block;margin-bottom:6px}
.stat b{font-size:23px;font-weight:600;letter-spacing:-.5px}
.stat i{font-style:normal;font-size:12px;color:var(--dim);margin-left:6px}
label.f{display:block;font-size:12.5px;color:#334155;margin:0 0 5px;font-weight:500}
input.t,select.t,textarea.t{width:100%;padding:8px 10px;border:1px solid #cbd5e1;border-radius:7px;font-size:13px;
background:#fff;color:var(--txt);outline:none;font-family:inherit;transition:.12s}
input.t:focus,select.t:focus,textarea.t:focus{border-color:var(--pri);box-shadow:0 0 0 3px rgba(37,99,235,.12)}
textarea.t{resize:vertical;min-height:74px;line-height:1.55}
textarea.mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end}
.row>div{flex:1;min-width:170px}
.fld{margin-bottom:13px}
.btn{padding:8px 15px;border-radius:7px;border:1px solid var(--line);background:#fff;color:#334155;font-size:13px;
cursor:pointer;transition:.12s;font-family:inherit;white-space:nowrap}
.btn:hover{border-color:#94a3b8;background:#f8fafc}
.btn.pri{background:var(--pri);border-color:var(--pri);color:#fff}
.btn.pri:hover{background:#1d4ed8}
.btn.bad{color:var(--bad);border-color:#fecaca}
.btn.bad:hover{background:#fef2f2}
.btn.ok{color:var(--ok);border-color:#bbf7d0}
.btn.ok:hover{background:#f0fdf4}
.btn:disabled{opacity:.55;cursor:not-allowed}
.btn.sm{padding:4px 10px;font-size:12px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;font-weight:500;color:var(--dim);font-size:12px;padding:8px 10px;border-bottom:1px solid var(--line);
white-space:nowrap}
td{padding:9px 10px;border-bottom:1px solid #f1f5f9;vertical-align:middle}
tr:hover td{background:#f8fafc}
.tag{display:inline-block;padding:1px 8px;border-radius:20px;font-size:11.5px;line-height:19px}
.tag.ok{background:#dcfce7;color:#15803d}
.tag.off{background:#f1f5f9;color:#64748b}
.tag.warn{background:#fef3c7;color:#b45309}
.tag.bad{background:#fee2e2;color:#b91c1c}
.tag.blue{background:#dbeafe;color:#1d4ed8}
.mono{font-family:ui-monospace,Menlo,Consolas,monospace}
.dim{color:var(--dim)}
.small{font-size:12px}
.bar{height:7px;background:#e2e8f0;border-radius:4px;overflow:hidden}
.bar i{display:block;height:100%;background:var(--pri);border-radius:4px;transition:.3s}
.bar i.warn{background:var(--warn)}
.bar i.bad{background:var(--bad)}
.sw{position:relative;width:40px;height:22px;flex:0 0 40px;border-radius:11px;background:#cbd5e1;cursor:pointer;transition:.18s}
.sw:after{content:'';position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#fff;transition:.18s}
.sw.on{background:var(--ok)}
.sw.on:after{left:20px}
.line{display:flex;align-items:center;gap:12px;padding:11px 0;border-bottom:1px solid #f1f5f9}
.line:last-child{border-bottom:0}
.line .g{flex:1;min-width:0}
.line .g b{font-size:13.5px;font-weight:500;display:block}
.line .g span{font-size:12px;color:var(--dim)}
.empty{text-align:center;color:var(--dim);padding:36px 10px;font-size:13px}
.modal{position:fixed;inset:0;background:rgba(15,23,42,.5);display:flex;align-items:center;justify-content:center;
padding:18px;z-index:100}
.modal .box{background:#fff;border-radius:12px;width:100%;max-width:620px;max-height:88vh;overflow:auto;
box-shadow:0 24px 60px rgba(0,0,0,.3)}
.modal .hd{padding:16px 20px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:10px}
.modal .hd b{font-size:15px;flex:1}
.modal .bd{padding:18px 20px}
.modal .ft{padding:14px 20px;border-top:1px solid var(--line);display:flex;gap:10px;justify-content:flex-end}
.x{cursor:pointer;color:var(--dim);font-size:20px;line-height:1;border:0;background:none}
.toast{position:fixed;bottom:26px;left:50%;transform:translateX(-50%);background:#0f172a;color:#fff;padding:10px 20px;
border-radius:8px;font-size:13px;z-index:200;opacity:0;transition:.22s;pointer-events:none;max-width:88vw}
.toast.on{opacity:1}
pre.code{background:#0f172a;color:#e2e8f0;padding:14px;border-radius:8px;overflow:auto;font-size:12.5px;
font-family:ui-monospace,Menlo,Consolas,monospace;line-height:1.6;max-height:52vh}
.logline{display:flex;gap:10px;padding:6px 0;border-bottom:1px solid #f1f5f9;font-size:12.5px;
font-family:ui-monospace,Menlo,Consolas,monospace;align-items:flex-start}
.logline time{color:var(--dim);flex:0 0 128px}
.logline .lv{flex:0 0 48px;font-size:11px}
.logline .ms{flex:1;word-break:break-all;white-space:pre-wrap}
.lv.debug{color:#94a3b8}.lv.info{color:#2563eb}.lv.warn{color:#d97706}.lv.error{color:#dc2626}
.file{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid #f1f5f9;cursor:pointer}
.file:hover{background:#f8fafc}
.file b{font-weight:500;font-size:13px}
.chip{display:inline-block;padding:2px 9px;border-radius:6px;background:#f1f5f9;font-size:12px;color:#475569;margin:0 6px 6px 0}
.hint{background:#f8fafc;border:1px dashed #cbd5e1;border-radius:8px;padding:10px 13px;font-size:12.5px;color:#475569;line-height:1.7}
@media(max-width:760px){
 aside{transform:translateX(-100%);transition:.2s}
 aside.open{transform:none}
 main{margin-left:0}
 .burger{display:inline-flex!important}
 .wrap{padding:14px}
}
.burger{display:none;border:1px solid var(--line);background:#fff;border-radius:7px;padding:6px 10px;cursor:pointer}
/* ---------- V2:浮动玻璃面板 ---------- */
body.v2{--bg:#eef2ff;--card:rgba(255,255,255,.68);--line:rgba(15,23,42,.08);--txt:#0f172a;--dim:#64748b;--pri:#4f46e5;--ok:#059669;--warn:#d97706;--bad:#dc2626;
 background:
  radial-gradient(1200px 800px at 0% 0%,#dbeafe 0%,transparent 55%),
  radial-gradient(1000px 700px at 100% 8%,#f3e8ff 0%,transparent 52%),
  linear-gradient(135deg,#f8fafc 0%,#eef2ff 48%,#fdf2f8 100%);
 background-attachment:fixed;color:var(--txt)}
body.v2[data-accent="purple"]{--pri:#7c3aed}
body.v2[data-accent="green"]{--pri:#059669}
body.v2[data-accent="pink"]{--pri:#db2777}
body.v2[data-accent="amber"]{--pri:#d97706}
body.v2 .app{gap:18px;padding:18px;align-items:flex-start}
body.v2 aside{position:sticky;top:18px;height:calc(100vh - 36px);border-radius:24px;
 background:rgba(255,255,255,.62);border:1px solid rgba(255,255,255,.8);
 box-shadow:0 24px 60px rgba(15,23,42,.12);backdrop-filter:blur(24px);color:#334155}
body.v2 .brand{border-bottom:1px solid rgba(15,23,42,.06);padding:20px 18px 16px}
body.v2 .brand b{color:#0f172a}
body.v2 .brand i{color:#94a3b8}
body.v2 .nav{color:#475569;border-left:0;margin:2px 10px;border-radius:12px;padding:10px 12px;transition:.18s}
body.v2 .nav:hover{background:rgba(79,70,229,.08);color:#1e1b4b}
body.v2 .nav.on{background:linear-gradient(135deg,var(--pri),#8b5cf6);color:#fff;box-shadow:0 10px 24px rgba(79,70,229,.28)}
body.v2 .nav svg{opacity:.9}
body.v2 .nav-group{color:#94a3b8}
body.v2 main{margin-left:0;flex:1;min-width:0}
body.v2 .top{position:sticky;top:18px;z-index:12;background:rgba(255,255,255,.58);backdrop-filter:blur(22px);
 border:1px solid rgba(255,255,255,.8);border-radius:18px;margin:0 0 16px;padding:12px 16px;
 box-shadow:0 12px 34px rgba(15,23,42,.07)}
body.v2 .top h2{font-size:15px}
body.v2 .wrap{padding:0 0 44px}
body.v2 .card{background:rgba(255,255,255,.68);border:1px solid rgba(255,255,255,.82);border-radius:20px;
 box-shadow:0 16px 40px rgba(15,23,42,.07);backdrop-filter:blur(18px);padding:20px}
body.v2 .card h3{font-size:14px;letter-spacing:.01em}
body.v2 .stat{background:rgba(255,255,255,.7);border:1px solid rgba(255,255,255,.85);border-radius:18px;
 box-shadow:0 12px 30px rgba(15,23,42,.06)}
body.v2 .btn{border-radius:12px;border-color:rgba(15,23,42,.08);background:rgba(255,255,255,.72)}
body.v2 .btn:hover{background:#fff}
body.v2 .btn.pri{background:linear-gradient(135deg,var(--pri),#8b5cf6);border-color:transparent;color:#fff;
 box-shadow:0 8px 20px rgba(79,70,229,.26)}
body.v2 .btn.ok{background:linear-gradient(135deg,#10b981,#059669);border-color:transparent;color:#fff}
body.v2 .btn.bad{background:linear-gradient(135deg,#f87171,#dc2626);border-color:transparent;color:#fff}
body.v2 .t,body.v2 input.t,body.v2 textarea.t,body.v2 select.t{background:rgba(255,255,255,.78);
 border-color:rgba(15,23,42,.1);border-radius:11px}
body.v2 .t:focus,body.v2 input.t:focus,body.v2 textarea.t:focus,body.v2 select.t:focus{border-color:var(--pri);
 box-shadow:0 0 0 3px rgba(79,70,229,.12)}
body.v2 .line{border-bottom-color:rgba(15,23,42,.06)}
body.v2 .modal .box{border-radius:22px;background:rgba(255,255,255,.94);backdrop-filter:blur(24px);
 box-shadow:0 30px 80px rgba(15,23,42,.22)}
body.v2 .toast{background:rgba(15,23,42,.9);backdrop-filter:blur(12px);border-radius:12px}
body.v2 .me{border-top:1px solid rgba(15,23,42,.06)}
body.v2 .me p{color:#0f172a}
body.v2 .me:hover{background:rgba(79,70,229,.06);border-radius:14px;margin:0 10px}
body.v2 .hint{background:rgba(255,255,255,.55);border-color:rgba(15,23,42,.12);border-radius:12px}
body.v2 .chip{background:rgba(79,70,229,.08);color:#4338ca}
body.v2 .tag.ok{background:rgba(16,185,129,.12);color:#047857}
body.v2 .tag.off{background:rgba(100,116,139,.12);color:#475569}
body.v2 .tag.bad{background:rgba(220,38,38,.1);color:#b91c1c}
body.v2 .empty{color:#94a3b8}
body.v2 .sw{background:rgba(15,23,42,.16)}
body.v2 .sw.on{background:linear-gradient(135deg,var(--pri),#8b5cf6)}
body.v2 .avatar,body.v2 .av{box-shadow:0 6px 16px rgba(15,23,42,.12)}
body.v2 .ui-palette{display:flex;gap:8px;flex-wrap:wrap}
body.v2 .ui-palette button{width:30px;height:30px;border-radius:50%;border:2px solid #fff;cursor:pointer;
 box-shadow:0 4px 12px rgba(15,23,42,.15)}
body.v2 .ui-palette button.on{outline:2px solid var(--pri);outline-offset:2px}
body.v2 .card,body.v2 .stat{transition:transform .22s ease,box-shadow .22s ease,background .22s ease}
body.v2 .card:hover,body.v2 .stat:hover{transform:translateY(-2px);box-shadow:0 22px 50px rgba(15,23,42,.11)}
body.v2 .btn{transition:transform .16s ease,box-shadow .16s ease,background .16s ease}
body.v2 .btn:hover{transform:translateY(-1px)}
body.v2 .btn:active{transform:translateY(0) scale(.98)}
body.v2::before{content:'';position:fixed;inset:-20%;z-index:-1;pointer-events:none;
 background:
  radial-gradient(420px 420px at 18% 22%,rgba(99,102,241,.18),transparent 60%),
  radial-gradient(380px 380px at 82% 12%,rgba(217,70,239,.14),transparent 60%),
  radial-gradient(420px 420px at 68% 88%,rgba(14,165,233,.14),transparent 60%);
 animation:v2float 18s ease-in-out infinite alternate}
@keyframes v2float{0%{transform:translate3d(-1.5%,-1%,0) scale(1)}100%{transform:translate3d(1.5%,1.5%,0) scale(1.04)}}
body.v2 .top h2{background:linear-gradient(90deg,#0f172a,#4f46e5 70%,#db2777);
 -webkit-background-clip:text;background-clip:text;color:transparent}
body.v2 .stat b{background:linear-gradient(135deg,var(--pri),#db2777);
 -webkit-background-clip:text;background-clip:text;color:transparent}
@media(max-width:760px){
 body.v2 .app{padding:10px}
 body.v2 aside{position:fixed;top:10px;bottom:10px;left:10px;height:auto;border-radius:22px}
 body.v2 .top{top:10px;margin:0 0 12px}
 body.v2 .wrap{padding:0 0 34px}
 body.v2 .grid.g4{grid-template-columns:repeat(2,minmax(0,1fr))}
 body.v2 .grid.g2{grid-template-columns:1fr}
 body.v2 .card{padding:16px;border-radius:18px}
 body.v2 .top h2{font-size:14px}
}
@media(max-width:420px){
 body.v2 .grid.g4{grid-template-columns:1fr}
 body.v2 .stat b{font-size:18px}
}
</style>
</head>
<body class="${version === 'v2' ? 'v2' : ''}" data-accent="${esc(accent)}">
<div class="app">
  <aside id="sb">
    <div class="brand">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2"><path d="M12 2 2 7l10 5 10-5-10-5Z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
      <div><b>NOMO</b><br><i>管理面板</i></div>
    </div>
    <nav id="nav"></nav>
    <div class="me" id="me"></div>
  </aside>
  <main>
    <div class="top">
      <button class="burger" onclick="document.getElementById('sb').classList.toggle('open')">☰</button>
      <h2 id="title">首页</h2>
      <div class="sp"></div>
      <button class="btn sm" id="refresh">刷新</button>
    </div>
    <div class="wrap" id="view"><div class="empty">加载中…</div></div>
  </main>
</div>
<div id="modals"></div>
<div class="toast" id="toast"></div>
<script>
var API='/administrator/api';
var ME={user:'${esc(user)}',version:'${version === 'v2' ? 'v2' : 'v1'}',appVersion:'${esc(appVersion)}',checkUpdates:${checkUpdates !== false},warnings:${JSON.stringify(Array.isArray(warnings) ? warnings : []).replace(/</g, '\\u003c')}};
var S={route:'home',data:{},settings:null,overview:null};
function el(id){return document.getElementById(id)}
function h(s){return String(s===null||s===undefined?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function toast(m){var t=el('toast');t.textContent=m;t.classList.add('on');clearTimeout(t._t);t._t=setTimeout(function(){t.classList.remove('on')},2200)}
function api(p,opt){opt=opt||{};opt.headers=Object.assign({'X-Requested-With':'nomo'},opt.headers||{});
 if(opt.body&&typeof opt.body!=='string'){opt.body=JSON.stringify(opt.body);opt.headers['Content-Type']='application/json'}
 return fetch(API+p,opt).then(function(r){
   if(r.status===401){location.href='/administrator';return Promise.reject(new Error('未登录'))}
   return r.json().then(function(d){if(!r.ok)throw new Error(d.error||('HTTP '+r.status));return d})
 })}
function bytes(n){n=Number(n)||0;if(n<1024)return n+' B';if(n<1048576)return (n/1024).toFixed(1)+' KB';
 if(n<1073741824)return (n/1048576).toFixed(2)+' MB';return (n/1073741824).toFixed(2)+' GB'}
function ago(ts){if(!ts)return '-';var d=Date.now()-ts;if(d<60000)return Math.floor(d/1000)+' 秒前';
 if(d<3600000)return Math.floor(d/60000)+' 分钟前';if(d<86400000)return Math.floor(d/3600000)+' 小时前';return Math.floor(d/86400000)+' 天前'}
function left(ts){var d=Number(ts||0)-Date.now();if(d<=0)return '已过期';var s=Math.floor(d/1000);
 if(s<60)return s+' 秒';if(s<3600)return Math.floor(s/60)+' 分 '+ (s%60) +' 秒';return Math.floor(s/3600)+' 小时 '+Math.floor(s%3600/60)+' 分'}
function ts2s(ts){if(!ts)return '-';var d=new Date(Number(ts));function p(n){return n<10?'0'+n:''+n}
 return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds())}
function modal(title,body,foot){
 var m=document.createElement('div');m.className='modal';
 m.innerHTML='<div class="box"><div class="hd"><b>'+h(title)+'</b><button class="x">&times;</button></div><div class="bd">'+body+'</div>'+
  (foot?'<div class="ft">'+foot+'</div>':'')+'</div>';
 m.addEventListener('click',function(e){if(e.target===m||e.target.classList.contains('x'))m.remove()});
 el('modals').appendChild(m);return m}
function closeModals(){el('modals').innerHTML=''}
function confirmBox(title,text,onOk,danger){
 var m=modal(title,'<p style="font-size:13.5px;color:#334155;line-height:1.8">'+text+'</p>',
  '<button class="btn" data-x>取消</button><button class="btn '+(danger?'bad':'pri')+'" data-ok>确定</button>');
 m.querySelector('[data-x]').onclick=function(){m.remove()};
 m.querySelector('[data-ok]').onclick=function(){m.remove();onOk()}}
function sw(on,attr){return '<div class="sw'+(on?' on':'')+'" '+attr+'></div>'}
function showUpdateInfo(r){
 var lines=[];
 lines.push('<div class="hint">当前版本 <b>'+h(r.current||ME.appVersion)+'</b> · 最新版本 <b>'+h(r.latestVersion||'未知')+'</b></div>');
 if(r.latestSha)lines.push('<div class="small dim" style="margin-top:8px">最新提交 '+h(r.latestSha)+(r.latestDate?' · '+h(r.latestDate.slice(0,10)):'')+'</div>');
 if(r.latestMessage)lines.push('<div class="small" style="margin-top:6px">'+h(r.latestMessage)+'</div>');
 if(r.note)lines.push('<div class="small" style="color:#b45309;margin-top:6px">'+h(r.note)+'</div>');
 lines.push('<div class="hint" style="margin-top:10px">'+(r.updateAvailable?'发现新版本。配置 Cloudflare Deploy Hook 后可以一键触发构建;没有配置就去 GitHub 手动推送。':'当前已是最新版本。')+'</div>');
 var footer='<button class="btn" data-x>关闭</button>'+(r.updateAvailable?'<button class="btn pri" data-upd>立即更新</button>':'');
 var m=modal('检查更新',lines.join(''),footer);
 m.querySelector('[data-x]').onclick=function(){m.remove()};
 if(r.updateAvailable)m.querySelector('[data-upd]').onclick=function(){var b=this;b.disabled=true;b.textContent='触发中…';
  api('/update/deploy',{method:'POST'}).then(function(x){toast(x.note||'已触发部署');m.remove()})
   .catch(function(e){toast(e.message);b.disabled=false;b.textContent='立即更新'})};
}
var NAV=[
 ['home','首页','M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z'],
 ['homepage','首页配置','M4 5h16v14H4zM4 9h16'],
 ['agent','Agent 配置','M12 3a4 4 0 0 1 4 4c0 1.1-.5 2.1-1.2 2.8A6 6 0 0 1 18 15v3H6v-3a6 6 0 0 1 3.2-5.2A4 4 0 0 1 12 3zM9 21h6'],
 ['ext','扩展管理','M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z'],
 ['projects','部署项目','M3 5h7l2 2h9v12H3zM3 11h18'],
 ['storage','存储','M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3'],
 ['settings','设置','M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7.5 19l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3 13.6H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 10 3V3a2 2 0 1 1 4 0v.1A1.6 1.6 0 0 0 16.5 4.5l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.6 1.6 0 0 0 21 10.1V10a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z'],
 ['logs','日志','M4 4h16v16H4zM8 8h8M8 12h8M8 16h5'],
];
function renderNav(){
 var r=S.route.split('/')[0];
 var active=['mcp','skills','exts','modules'].indexOf(r)>=0?'ext':r;
 var lastGroup='';
 el('nav').innerHTML=NAV.map(function(n){
  var head='';
  if(n[3]&&n[3]!==lastGroup){head='<div class="nav-group">'+h(n[3])+'</div>';lastGroup=n[3];}
  return head+'<div class="nav'+(active===n[0]?' on':'')+'" data-go="'+n[0]+'">'+
   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="'+n[2]+'"/></svg>'+
   '<span>'+n[1]+'</span>'+(S.badges&&S.badges[n[0]]?'<i class="dot">'+S.badges[n[0]]+'</i>':'')+'</div>'}).join('');
 var col='#'+['2563eb','16a34a','d97706','dc2626','7c3aed','0891b2'][(ME.user.charCodeAt(0)||78)%6];
 el('me').innerHTML='<div class="av" style="background:'+col+'">'+h(ME.user.slice(0,1).toUpperCase())+'</div>'+
  '<div><p>'+h(ME.user)+'</p><span>管理员</span></div>';
}
el('nav').addEventListener('click',function(e){var d=e.target.closest('[data-go]');if(d){go(d.dataset.go)}});
el('me').addEventListener('click',profile);
function profile(){
 var m=modal('账号','<div style="display:flex;align-items:center;gap:14px;margin-bottom:16px">'+
  '<div class="av" style="background:#2563eb;width:52px;height:52px;flex:0 0 52px;font-size:20px">'+h(ME.user.slice(0,1).toUpperCase())+'</div>'+
  '<div><b style="font-size:16px">'+h(ME.user)+'</b><br><span class="dim small">管理员 · 用户名与密码在 Cloudflare 环境变量中修改</span></div></div>'+
  '<div class="hint">登录状态有效期 7 天,退出后需要重新输入用户名和密码。</div>',
  '<button class="btn" data-x>关闭</button><button class="btn bad" data-out>退出登录</button>');
 m.querySelector('[data-x]').onclick=function(){m.remove()};
 m.querySelector('[data-out]').onclick=function(){
  api('/logout',{method:'POST'}).then(function(){location.href='/administrator'})};
}
function go(r){S.route=r;location.hash='#/'+r;render()}
window.addEventListener('hashchange',function(){var r=(location.hash||'').replace(/^#\\/?/,'')||'home';S.route=r;render()});
el('refresh').onclick=function(){S.settings=null;render(true)};
function render(force){
 var r=S.route.split('/');
 renderNav();
 el('sb').classList.remove('open');
 // 换一个全新的 #view 节点:旧页面的异步回调只会写进已经脱离文档的旧节点,
 // 不会再覆盖新页面。这样快速点侧边栏时不会出现「导航是 A、内容是 B」的串台。
 var oldView=el('view');
 var freshView=document.createElement('div');
 freshView.className='wrap';
 freshView.id='view';
 freshView.innerHTML='<div class="empty">加载中…</div>';
 if(oldView&&oldView.parentNode)oldView.parentNode.replaceChild(freshView,oldView);
 if(r[0]==='home')return pageHome();
 if(r[0]==='homepage')return pageHomepageConfig();
 if(r[0]==='agent')return pageAgent();
 if(r[0]==='ext')return pageExtHub();
 if(r[0]==='mcp')return pageMcp();
 if(r[0]==='skills')return pageSkills();
 if(r[0]==='exts')return pageExts();
 if(r[0]==='modules')return pageModules();
 if(r[0]==='storage')return r[1]?pageStoreDetail(r[1]):pageStorage();
 if(r[0]==='projects')return r[1]?pageProject(r[1]):pageProjects();
 if(r[0]==='new')return pageNew();
 if(r[0]==='settings')return pageSettings();
 if(r[0]==='logs')return pageLogs();
 return pageHome();
}
function setTitle(t){el('title').textContent=t}
function pageHome(){
 setTitle('首页');
 var v=el('view');v.innerHTML='<div class="empty">加载中…</div>';
 api('/overview').then(function(d){
  S.overview=d;
  var t=d.totals||{},td=d.today||{},q=d.quota||{};
  var max=1;(d.daily||[]).forEach(function(x){max=Math.max(max,x.visits,x.messages)});
  v.innerHTML=
  '<div class="grid g5" style="margin-bottom:16px">'+
   card('累计访问',t.visits,'人次')+card('累计消息',t.messages,'条')+
   card('累计部署',t.projects,'个')+card('今日访问',td.visits,'人次')+card('今日消息',td.messages,'条')+
  '</div>'+
  '<div class="grid g2">'+
   '<div class="card"><h3>最近 14 天</h3><div class="sub">蓝色为访问人次,绿色为消息条数</div>'+
    chart(d.daily||[])+'</div>'+
   '<div class="card"><h3>系统信息</h3><div class="sub">当前运行状态</div>'+
    kv('连接方式',d.mode==='webhook'?'WebHook':'WebSocket')+
    kv('模型',(d.model||'-')+' · 思考 '+(d.effort||'-'))+
    kv('在线项目',(t.activeProjects||0)+' / '+(q.maxProjects||0)+' 个')+
    kv('KV 已用',bytes(q.used)+' / '+bytes(q.total))+
    kv('KV 动态池',bytes(q.dynamic)+' · 每项目保底 '+bytes(q.per))+
    kv('群聊数',(d.groups||[]).length+' 个')+
    kv('运行日志',(t.errors||0)+' 条错误')+
   '</div>'+
  '</div>'+
  '<div class="card"><h3>使用过本机器人的群聊</h3><div class="sub">群聊名称显示为它的 openID</div>'+
   (d.groups&&d.groups.length?'<table><thead><tr><th>群聊 openID</th><th>消息数</th><th>最近活跃</th><th>状态</th></tr></thead><tbody>'+
    d.groups.map(function(g){return '<tr><td class="mono">'+h(g.openid)+'</td><td>'+g.msgCount+'</td><td class="dim">'+ago(g.lastSeen)+
     '</td><td>'+(g.enabled?'<span class="tag ok">启用</span>':'<span class="tag off">禁用</span>')+'</td></tr>'}).join('')+'</tbody></table>'
    :'<div class="empty">还没有群聊使用过</div>')+
  '</div>'+
  '<div class="card"><h3>详细信息</h3><div class="sub">累计计数器</div><div class="grid g3">'+
   kv2('累计回复',t.replies)+kv2('累计工具调用',t.tools)+kv2('累计 token',t.tokens)+
   kv2('累计部署',t.projects)+kv2('今日部署',td.projects)+kv2('错误日志',t.errors)+
  '</div></div>';
 }).catch(function(e){v.innerHTML='<div class="card"><div class="empty">'+h(e.message)+'</div></div>'});
}
function pageHomepageConfig(){
 setTitle('首页配置');
 var v=el('view');v.innerHTML='<div class="empty">加载中…</div>';
 loadSettings(true).then(function(d){
  var hp=(d.settings.ui&&d.settings.ui.homepage)||{};
  v.innerHTML='<div class="card"><h3>公开首页</h3><div class="sub">访问网站根路径 / 时显示的页面。它不依赖 D1/KV,面板没配置好也能打开。</div>'+
   '<div class="line"><div class="g"><b>启用首页</b><span>关闭后访问 / 会返回 404</span></div>'+sw(hp.enabled!==false,'data-t="hpEnabled"')+'</div>'+
   '<div class="fld"><label class="f">标题</label><input class="t" id="hp-title" value="'+h(hp.title||'NOMO')+'" placeholder="NOMO"></div>'+
   '<div class="fld"><label class="f">副标题</label><input class="t" id="hp-sub" value="'+h(hp.subtitle||'QQ 群聊 · AI 助手')+'" placeholder="QQ 群聊 · AI 助手"></div>'+
   '<div class="fld"><label class="f">介绍文字</label><textarea class="t" id="hp-desc" style="min-height:110px">'+h(hp.description||'')+'</textarea></div>'+
   '<div class="fld"><label class="f">GitHub 地址</label><input class="t mono" id="hp-github" value="'+h(hp.github||'https://github.com/MN-LKs/NOMO-QQBot')+'" placeholder="https://github.com/..."></div>'+
   '<div class="line"><div class="g"><b>显示 GitHub 按钮</b><span>首页主按钮和页脚都显示</span></div>'+sw(hp.showGithub!==false,'data-t="hpGithub"')+'</div>'+
   '<div class="line"><div class="g"><b>使用自定义首页</b><span>开启后直接返回下面的 HTML,不再使用内置模板</span></div>'+sw(hp.custom===true,'data-t="hpCustom"')+'</div>'+
   '<div class="fld"><label class="f">自定义 HTML</label><textarea class="t mono" id="hp-html" style="min-height:220px" placeholder="<!DOCTYPE html>...">'+h(hp.html||'')+'</textarea></div>'+
   '<div class="fld"><label class="f">首页后端 JS(可选)</label><textarea class="t mono" id="hp-backend" style="min-height:160px" placeholder="return { ok: true, path: ctx.path };">'+h(hp.backend||'')+'</textarea>'+
   '<div class="small dim" style="margin-top:4px">自定义首页里的脚本可以请求 <span class="mono">/home-api/任意路径</span>,由这段 JS 在沙盒里执行;支持 ctx.method / ctx.path / ctx.query / ctx.body / ctx.json() / ctx.fetch()。</div></div>'+
   '<div style="display:flex;gap:10px;margin-top:14px"><button class="btn pri" id="hp-save">保存</button><a class="btn" href="/" target="_blank" rel="noopener">打开首页</a></div>'+
   '<div class="hint" style="margin-top:12px">首页是公开页面,不要在介绍里写密钥或内部地址。自定义 HTML 会原样返回,请自己保证安全。</div></div>';
  v.querySelector('[data-t="hpEnabled"]').onclick=function(){this.classList.toggle('on')};
  v.querySelector('[data-t="hpGithub"]').onclick=function(){this.classList.toggle('on')};
  v.querySelector('[data-t="hpCustom"]').onclick=function(){this.classList.toggle('on')};
  v.querySelector('#hp-save').onclick=function(){
   var b=this;b.disabled=true;b.textContent='保存中…';
   api('/settings',{method:'POST',body:{ui:{homepage:{
    enabled:v.querySelector('[data-t="hpEnabled"]').classList.contains('on'),
    showGithub:v.querySelector('[data-t="hpGithub"]').classList.contains('on'),
    custom:v.querySelector('[data-t="hpCustom"]').classList.contains('on'),
    html:v.querySelector('#hp-html').value,
    backend:v.querySelector('#hp-backend').value,
    title:v.querySelector('#hp-title').value.trim(),
    subtitle:v.querySelector('#hp-sub').value.trim(),
    description:v.querySelector('#hp-desc').value.trim(),
    github:v.querySelector('#hp-github').value.trim(),
   }}}}).then(function(){toast('首页已保存');S.settings=null})
    .catch(function(e){toast(e.message)}).then(function(){b.disabled=false;b.textContent='保存'})};
 }).catch(function(e){v.innerHTML='<div class="card"><div class="empty">'+h(e.message)+'</div></div>'});
}
function card(t,v,u){return '<div class="stat"><span>'+h(t)+'</span><b>'+(v||0)+'</b><i>'+h(u||'')+'</i></div>'}
function kv(k,v){return '<div class="line"><div class="g"><span>'+h(k)+'</span></div><b class="small">'+h(v)+'</b></div>'}
function kv2(k,v){return '<div><span class="dim small">'+h(k)+'</span><br><b style="font-size:17px">'+(Number(v)||0)+'</b></div>'}
function chart(daily){
 if(!daily.length)return '<div class="empty">暂无数据</div>';
 var max=1;daily.forEach(function(d){max=Math.max(max,d.visits,d.messages)});
 return '<div style="display:flex;gap:6px;align-items:flex-end;height:150px;padding-top:10px">'+
  daily.map(function(d){
   var hv=Math.round((d.visits/max)*110),hm=Math.round((d.messages/max)*110);
   return '<div style="flex:1;display:flex;gap:2px;align-items:flex-end;justify-content:center" title="'+d.day+' 访问 '+d.visits+' 消息 '+d.messages+'">'+
    '<div style="width:42%;height:'+Math.max(2,hv)+'px;background:#3b82f6;border-radius:3px 3px 0 0"></div>'+
    '<div style="width:42%;height:'+Math.max(2,hm)+'px;background:#22c55e;border-radius:3px 3px 0 0"></div></div>'}).join('')+
  '</div><div style="display:flex;gap:6px;margin-top:6px">'+daily.map(function(d){
   return '<div style="flex:1;text-align:center;font-size:10px;color:#94a3b8">'+d.day.slice(5)+'</div>'}).join('')+'</div>';
}
function pageProjects(){
 setTitle('部署项目');
 var v=el('view');v.innerHTML='<div class="empty">加载中…</div>';
 api('/projects').then(function(d){
  v.innerHTML='<div class="card"><div style="display:flex;align-items:center;gap:12px;margin-bottom:14px">'+
   '<div style="flex:1"><h3>在线项目</h3><div class="sub" style="margin:0">共 '+d.projects.length+' / '+d.quota.maxProjects+
   ' 个 · 每个项目保底 '+bytes(d.quota.per)+' · 动态池 '+bytes(d.quota.dynamic)+' · 已用 '+bytes(d.quota.used)+'</div></div>'+
   '<button class="btn pri" data-new>部署项目</button></div>'+
   (d.projects.length?'<table><thead><tr><th>名称</th><th>ID</th><th>大小</th><th>访问</th><th>剩余有效期</th><th style="width:210px"></th></tr></thead><tbody>'+
    d.projects.map(function(p){
     return '<tr><td><b>'+h(p.name)+'</b><br><span class="dim small">'+h(p.url)+'</span></td>'+
      '<td class="mono small">'+h(p.id)+'</td><td class="small">'+bytes(p.bytes)+'</td><td class="small">'+p.hits+'</td>'+
      '<td class="small">'+left(p.expiresAt)+'</td>'+
      '<td style="text-align:right"><button class="btn sm" data-open="'+h(p.id)+'">详情</button> '+
      '<button class="btn sm ok" data-ext="'+h(p.id)+'">续期</button> '+
      '<button class="btn sm bad" data-del="'+h(p.id)+'">删除</button></td></tr>'}).join('')+'</tbody></table>'
    :'<div class="empty">还没有部署任何项目,点右上角「部署项目」创建一个</div>')+
   '<div class="hint" style="margin-top:14px">项目只支持纯 HTML / CSS / JS 静态文件,不再执行服务端代码。'+
   '删除或过期后,它在 KV 与 D1 里的数据会一并清掉。</div>'+
  '</div>';
  v.querySelector('[data-new]').onclick=function(){go('new')};
  v.querySelectorAll('[data-open]').forEach(function(b){b.onclick=function(){go('projects/'+b.dataset.open)}});
  v.querySelectorAll('[data-ext]').forEach(function(b){b.onclick=function(){
   confirmBox('延续有效期','确认给这个项目增加 '+d.extendMinutes+' 分钟有效期?',function(){
    api('/projects/'+b.dataset.ext+'/extend',{method:'POST',body:{seconds:d.extendMinutes*60}})
     .then(function(r){toast('已续期,新到期时间 '+ts2s(r.expiresAt));render()}).catch(function(e){toast(e.message)})})}});
  v.querySelectorAll('[data-del]').forEach(function(b){b.onclick=function(){
   var p=d.projects.filter(function(x){return x.id===b.dataset.del})[0]||{};
   confirmBox('删除项目','确认删除「'+h(p.name||'')+'」?<br><br>它的全部文件、KV 占用和 D1 数据都会被永久删除,无法恢复。',function(){
    api('/projects/'+b.dataset.del,{method:'DELETE'}).then(function(){toast('已删除');render()}).catch(function(e){toast(e.message)})},true)}});
 }).catch(function(e){v.innerHTML='<div class="card"><div class="empty">'+h(e.message)+'</div></div>'});
}
function pageProject(id){
 setTitle('项目详情');
 var v=el('view');v.innerHTML='<div class="empty">加载中…</div>';
 api('/projects/'+id).then(function(d){
  var p=d.project,q=d.quota,u=d.usage;
  var pct=Math.min(100,Math.round((u.bytes/Math.max(1,q.limit))*100));
  v.innerHTML='<div class="card"><div style="display:flex;align-items:center;gap:12px">'+
   '<div style="flex:1"><h3>'+h(p.name)+'</h3><div class="sub" style="margin:0">'+h(p.description||'没有说明')+'</div></div>'+
   '<button class="btn" data-back>返回列表</button></div></div>'+
  '<div class="grid g3">'+
   '<div class="card"><h3>基本信息</h3>'+
    kv('项目 ID',p.id)+kv('访问网址',p.url)+kv('创建时间',ts2s(p.createdAt))+
    kv('到期时间',ts2s(p.expiresAt))+'<div class="line"><div class="g"><span>剩余有效期</span></div><b class="small">'+left(p.expiresAt)+'</b></div>'+
    kv('访问次数',p.hits)+kv('来源',p.source==='ai'?'AI 部署':'面板部署')+
    '<div style="margin-top:14px;display:flex;gap:8px"><button class="btn ok" data-ext>延续 '+d.extendMinutes+' 分钟</button>'+
    '<button class="btn" data-open-url>打开网址</button><button class="btn bad" data-del>删除项目</button></div></div>'+
   '<div class="card"><h3>占用情况</h3><div class="sub">KV 文件占用 / 本项目可用额度</div>'+
    '<div class="bar"><i class="'+(pct>85?'bad':pct>60?'warn':'')+'" style="width:'+pct+'%"></i></div>'+
    '<div class="small dim" style="margin:6px 0 14px">'+bytes(u.bytes)+' / '+bytes(q.limit)+' ('+pct+'%)</div>'+
    kv('保底空间',bytes(q.base))+kv('动态分配',bytes(q.share))+kv('文件数',u.files)+
    kv('压缩前',bytes(u.rawBytes))+kv('D1 数据',bytes(u.dataBytes)+' / '+bytes(d.dataQuota))+
    kv('D1 键数',u.dataKeys)+'</div>'+
   '<div class="card"><h3>文件列表</h3><div class="sub">点击查看内容</div>'+
    (d.files.length?d.files.map(function(f){
     return '<div class="file" data-f="'+h(f.path)+'"><b>'+h(f.path)+'</b><span class="dim small" style="margin-left:auto">'+
      h(f.ct.split(';')[0])+' · '+bytes(f.size)+(f.gz?' · 已压缩':'')+'</span></div>'}).join('')
    :'<div class="empty">没有文件</div>')+'</div>'+
  '</div>';
  v.querySelector('[data-back]').onclick=function(){go('projects')};
  v.querySelector('[data-open-url]').onclick=function(){window.open(p.url,'_blank')};
  v.querySelector('[data-ext]').onclick=function(){
   confirmBox('延续有效期','确认增加 '+d.extendMinutes+' 分钟?',function(){
    api('/projects/'+id+'/extend',{method:'POST',body:{seconds:d.extendMinutes*60}})
     .then(function(r){toast('已续期到 '+ts2s(r.expiresAt));render()}).catch(function(e){toast(e.message)})})};
  v.querySelector('[data-del]').onclick=function(){
   confirmBox('删除项目','确认删除「'+h(p.name)+'」?<br><br>文件、KV 占用与 D1 数据都会永久删除。',function(){
    api('/projects/'+id,{method:'DELETE'}).then(function(){toast('已删除');go('projects')}).catch(function(e){toast(e.message)})},true)};
  v.querySelectorAll('[data-f]').forEach(function(b){b.onclick=function(){viewFile(id,b.dataset.f)}});
 }).catch(function(e){v.innerHTML='<div class="card"><div class="empty">'+h(e.message)+'</div></div>'});
}
function viewFile(id,path){
 var m=modal('文件 · '+path,'<div class="empty">加载中…</div>','<button class="btn" data-x>关闭</button>');
 m.querySelector('[data-x]').onclick=function(){m.remove()};
 api('/projects/'+id+'/file?path='+encodeURIComponent(path)).then(function(d){
  var b=m.querySelector('.bd');
  if(d.kind==='image')b.innerHTML='<img src="'+d.data+'" style="max-width:100%;border-radius:8px">';
  else if(d.kind==='video')b.innerHTML='<video src="'+d.data+'" controls style="max-width:100%;border-radius:8px"></video>';
  else if(d.kind==='audio')b.innerHTML='<audio src="'+d.data+'" controls style="width:100%"></audio>';
  else if(d.kind==='text')b.innerHTML='<pre class="code">'+h(d.data)+'</pre>';
  else b.innerHTML='<div class="hint">这是二进制文件('+h(d.ct)+', '+bytes(d.size)+'),无法直接预览。</div>'+
   '<div style="margin-top:12px"><a class="btn" href="'+d.data+'" download>下载文件</a></div>';
 }).catch(function(e){m.querySelector('.bd').innerHTML='<div class="empty">'+h(e.message)+'</div>'});
}
function pageNew(){
 setTitle('部署项目');
 var files=[{path:'index.html',content:''}];
 var backendMode='none',siteModules=[],NL=String.fromCharCode(10);
 var v=el('view');
 v.innerHTML='<div class="empty">加载中…</div>';
 loadSettings().then(function(){
  api('/modules').then(function(d){siteModules=(d.modules||[]).filter(function(m){return m.enabled!==false&&(m.callPoints||[]).indexOf('site')>=0});draw()}).catch(function(){draw()});
 }).catch(function(){draw()});
 function draw(){
  v.innerHTML='<div class="card"><h3>部署新项目</h3><div class="sub">纯静态文件,支持 HTML / CSS / JS / 图片。提交后会得到一个 8 位 ID 与访问网址。</div>'+
   '<div class="row"><div><label class="f">项目名称</label><input class="t" id="n" placeholder="例如:2048 小游戏"></div>'+
   '<div><label class="f">有效期(分钟)</label><input class="t" id="ttl" type="number" min="1" value="'+S.ttlMinutes+'"></div></div>'+
   '<div class="fld" style="margin-top:13px"><label class="f">说明(可选)</label><input class="t" id="d" placeholder="一句话说明"></div>'+
   '<div class="fld"><label class="f">后端能力</label><select class="t" id="backend-mode">'+
    '<option value="none"'+(backendMode==='none'?' selected':'')+'>纯静态(HTML/CSS/JS + ./__data 简易存储)</option>'+
    '<option value="custom"'+(backendMode==='custom'?' selected':'')+'>自定义 _backend.js(沙盒执行)</option>'+
    '<option value="prefab"'+(backendMode==='prefab'?' selected':'')+'>预制后端模块(管理员在「模块」里勾了站点后端)</option>'+
   '</select><div class="hint" id="backend-hint" style="margin-top:8px">'+
    (backendMode==='custom'?'已加入 _backend.js 模板:用 ctx.method / ctx.path / ctx.body / ctx.store 读写数据,return 返回结果。':
     backendMode==='prefab'?(siteModules.length?'可用模块:'+siteModules.map(function(m){return m.id+'('+m.name+')'}).join('、')+'。页面里 fetch("/api/模块id") 即可调用。<div style="margin-top:8px"><button class="btn sm" id="insert-prefab">插入调用示例</button></div>':'还没有勾了「站点后端」的预制模块,先去「模块」页配置。'):
     '页面里可以用 fetch("./__data/键") 读写简易数据;需要服务端逻辑时再选自定义或预制后端。')+
   '</div></div>'+
   '<div class="fld"><label class="f">文件</label>'+files.map(function(f,i){
     return '<div style="border:1px solid #e2e8f0;border-radius:9px;padding:12px;margin-bottom:10px">'+
      '<div class="row" style="align-items:center"><div style="flex:0 0 240px"><input class="t mono" data-p="'+i+'" value="'+h(f.path)+'" placeholder="index.html"></div>'+
      '<div style="flex:1"><span class="dim small">'+(f.content.length?f.content.length+' 字符':'空')+'</span></div>'+
      '<button class="btn sm bad" data-rm="'+i+'">移除</button></div>'+
      '<textarea class="t mono" data-c="'+i+'" style="margin-top:10px;min-height:150px" placeholder="粘贴文件内容…">'+h(f.content)+'</textarea></div>'}).join('')+
    '<button class="btn" id="addf">+ 新增文件</button></div>'+
   '<div style="display:flex;gap:10px"><button class="btn pri" id="sub">部署</button><button class="btn" id="back">返回列表</button></div>'+
   '<div class="hint" style="margin-top:14px">单个文件最大 '+bytes(S.maxFileBytes)+'。HTML 里可以直接用相对路径引用同项目的其它文件。'+
   '需要存数据的话,页面里可以调用 <span class="mono">fetch("./__data/键", {method:"POST", body:"值"})</span> 保存,用 <span class="mono">fetch("./__data/键")</span> 读取。</div></div>';
  v.querySelector('#back').onclick=function(){go('projects')};
  v.querySelector('#backend-mode').onchange=function(){
   backendMode=this.value;
   if(backendMode==='custom'&&!files.some(function(f){return f.path==='_backend.js'})){
    files.push({path:'_backend.js',content:'// 自定义后端:页面 fetch("/api/hello") 会执行这里'+NL+'return { ok: true, method: ctx.method, path: ctx.path, query: ctx.query };'+NL});
   }
   draw();
  };
  if(v.querySelector('#insert-prefab'))v.querySelector('#insert-prefab').onclick=function(){
   var m=siteModules[0];if(!m)return;
   var idx=files.findIndex(function(f){return f.path==='index.html'});
   if(idx<0){files.push({path:'index.html',content:''});idx=files.length-1}
   files[idx].content+='<'+'script>'+NL+'fetch("/api/'+m.id+'",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({})}).then(r=>r.json()).then(console.log);'+NL+'<'+'/script>';
   draw();
  };
  v.querySelector('#addf').onclick=function(){files.push({path:'',content:''});draw()};
  v.querySelectorAll('[data-rm]').forEach(function(b){b.onclick=function(){files.splice(Number(b.dataset.rm),1);if(!files.length)files.push({path:'index.html',content:''});draw()}});
  v.querySelectorAll('[data-p]').forEach(function(i){i.oninput=function(){files[Number(i.dataset.p)].path=i.value}});
  v.querySelectorAll('[data-c]').forEach(function(i){i.oninput=function(){files[Number(i.dataset.c)].content=i.value}});
  v.querySelector('#sub').onclick=function(){
   var payload={name:v.querySelector('#n').value,description:v.querySelector('#d').value,
    ttlMinutes:Number(v.querySelector('#ttl').value)||S.ttlMinutes,files:files.filter(function(f){return f.path&&f.content})};
   if(!payload.name){toast('请填写项目名称');return}
   if(!payload.files.length){toast('至少需要一个有内容的文件');return}
   var b=v.querySelector('#sub');b.disabled=true;b.textContent='部署中…';
   api('/projects',{method:'POST',body:payload}).then(function(r){toast('部署成功');go('projects/'+r.id)})
    .catch(function(e){toast(e.message);b.disabled=false;b.textContent='部署'})};
 }
 draw();
}
function loadSettings(force){
 if(S.settings&&!force)return Promise.resolve(S.settings);
 return api('/settings').then(function(d){S.settings=d;S.ttlMinutes=(d.deploy&&d.deploy.ttlMinutes)||S.ttlMinutes;S.extendMinutes=(d.deploy&&d.extendMinutes)||S.extendMinutes;S.maxFileBytes=d.maxFileBytes||S.maxFileBytes;return d});
}
function pageAgent(){
 setTitle('Agent 配置');
 var v=el('view');v.innerHTML='<div class="empty">加载中…</div>';
 loadSettings(true).then(function(d){
  var s=(d&&d.settings)||{},llm=s.llm||{},se=s.search||{},ag=s.agent||{},dash=s.dashboard||{},motd=s.motd||{};
  var headers=function(o){return h(JSON.stringify(o||{},null,0))};
  var mapObj=se.response||{},mapText=Object.keys(mapObj).some(function(k){return mapObj[k]})?JSON.stringify(mapObj):'';
  var mods=Array.isArray(ag.modalities)?ag.modalities:['text'];
  var vision=ag.vision===true;
  v.innerHTML=
  '<div class="card"><h3>大模型接口</h3><div class="sub">机器人思考与对话用的接口。支持任意兼容 /chat/completions 的服务</div>'+
   '<div class="fld"><label class="f">接口地址 Base URL</label><input class="t mono" id="ag-llm-url" value="'+h(llm.baseUrl)+'" placeholder="https://api.example.com/v1"></div>'+
   '<div class="fld"><label class="f">API Key</label><input class="t mono" id="ag-llm-key" value="'+h(llm.apiKey)+'" placeholder="sk-..."></div>'+
   '<div class="row"><div><label class="f">模型 ID</label><input class="t mono" id="ag-llm-model" value="'+h(llm.model)+'"></div>'+
   '<div style="flex:0 0 140px"><label class="f">&nbsp;</label><button class="btn" id="ag-llm-list" style="width:100%">模型列表</button></div>'+
   '<div style="flex:0 0 140px"><label class="f">&nbsp;</label><button class="btn pri" id="ag-llm-test" style="width:100%">测试</button></div></div>'+
   '<div class="fld" id="ag-llm-models"></div>'+
   '<div class="row"><div><label class="f">推理等级</label><select class="t" id="ag-llm-effort">'+
    ['none','minimal','low','medium','high','max'].map(function(x){return '<option value="'+x+'"'+(llm.reasoningEffort===x?' selected':'')+'>'+x+'</option>'}).join('')+
   '</select></div><div><label class="f">深度思考</label><select class="t" id="ag-llm-think"><option value="1"'+ (llm.deepThinking!==false?' selected':'')+'>开启</option><option value="0"'+(llm.deepThinking===false?' selected':'')+'>关闭</option></select></div></div>'+
   '<div class="fld"><label class="f">自定义请求头(JSON,可留空)</label><textarea class="t mono" id="ag-llm-headers" placeholder=\\'{"X-Foo":"bar"}\\'>'+headers(llm.headers)+'</textarea></div>'+
   '<div class="fld"><label class="f">中转站用量面板地址(「查额度」工具用,可留空)</label><input class="t mono" id="ag-llm-dash" value="'+h(dash.url||'')+'" placeholder="https://manage.example.com/api/dashboard"></div>'+
   '<div class="row"><div><label class="f">单次请求限时</label><select class="t" id="ag-llm-limit"><option value="0"'+ (llm.timeLimitEnabled!==true?' selected':'')+'>不限制(推荐)</option><option value="1"'+(llm.timeLimitEnabled===true?' selected':'')+'>限制</option></select></div>'+
   '<div><label class="f">最大秒数</label><input class="t" type="number" id="ag-llm-secs" value="'+(llm.maxSeconds||600)+'"></div></div>'+
   '<button class="btn pri" id="ag-llm-save">保存</button></div>'+

  '<div class="card"><h3>联网搜索</h3><div class="sub">填一个到 /v1 为止的地址:搜索走 /search,读取正文走 /reader。支持秘塔、Exa、Tavily、Serper、Brave、Bing、Google 等</div>'+
   '<div class="fld"><label class="f">接口地址 Base URL</label><input class="t mono" id="ag-se-base" value="'+h(se.baseUrl||'')+'" placeholder="https://api.example.com/v1"></div>'+
   '<div class="fld"><label class="f">API Key</label><input class="t mono" id="ag-se-key" value="'+h(se.key)+'"></div>'+
   '<div class="row"><div><label class="f">搜索路径</label><input class="t mono" id="ag-se-spath" value="'+h(se.searchPath||'/search')+'"></div>'+
   '<div><label class="f">读取路径</label><input class="t mono" id="ag-se-rpath" value="'+h(se.readerPath||'/reader')+'"></div></div>'+
   '<div class="row"><div><label class="f">每次返回条数(1-10)</label><input class="t" type="number" min="1" max="10" id="ag-se-results" value="'+(se.results||5)+'"></div>'+
   '<div><label class="f">读取请求的 format 字段(可留空)</label><input class="t mono" id="ag-se-format" value="'+h(se.readerFormat||'')+'"></div></div>'+
   '<div class="fld"><label class="f">自定义请求头(JSON)</label><textarea class="t mono" id="ag-se-headers">'+headers(se.headers)+'</textarea></div>'+
   '<div class="fld"><label class="f">返回结构映射(JSON,可留空)</label><textarea class="t mono" id="ag-se-map">'+h(mapText)+'</textarea></div>'+
   '<div class="line"><div class="g"><b>启用联网搜索</b><span>关闭后机器人不再联网</span></div>'+sw(se.enabled!==false,'data-t="agSeEnabled"')+'</div>'+
   '<div class="line"><div class="g"><b>搜索后附第一条正文</b><span>会多花一次请求</span></div>'+sw(se.mergeReader!==false,'data-t="agSeMerge"')+'</div>'+
   '<button class="btn pri" id="ag-se-save">保存</button> <button class="btn" id="ag-se-test">测试搜索</button></div>'+

  '<div class="card"><h3>人设提示词</h3><div class="sub">留空使用默认人设。这段文字会作为系统提示词的一部分发给模型</div>'+
   '<textarea class="t" id="ag-persona" style="min-height:120px">'+h(s.persona||'')+'</textarea>'+
   '<div style="margin-top:12px"><button class="btn pri" id="ag-persona-save">保存人设</button></div></div>'+

  '<div class="card"><h3>工作流</h3><div class="sub">写给模型的工作步骤。比如「先搜索,再读正文,最后给结论」;留空使用默认流程</div>'+
   '<textarea class="t" id="ag-workflow" style="min-height:120px">'+h(llm.workflow||'')+'</textarea>'+
   '<div style="margin-top:12px"><button class="btn pri" id="ag-workflow-save">保存工作流</button></div></div>'+

  '<div class="card"><h3>模态能力</h3><div class="sub">图片识别是独立开关,默认关闭;只有打开后,群聊/单聊里的图片才会下载并作为多模态输入发给模型</div>'+
   '<div class="line"><div class="g"><b>文本</b><span>始终开启</span></div><span class="tag ok">已开启</span></div>'+
   '<div class="line"><div class="g"><b>图片识别</b><span>需要上游模型支持视觉;关闭时只把「[图片]」标签带进上下文</span></div>'+sw(vision,'data-t="agVision"')+'</div>'+
   '<div class="line"><div class="g"><b>语音</b><span>允许模型处理语音输入(需上游支持)</span></div>'+sw(mods.indexOf('audio')>=0,'data-mod="audio"')+'</div>'+
   '<button class="btn pri" id="ag-mod-save" style="margin-top:12px">保存模态</button></div>'+

  '<div class="card"><h3>工具</h3><div class="sub">内置工具组可以在这里直接开关;外部 HTTP 扩展在「扩展」页管理</div><div id="ag-tools"><div class="empty">加载中…</div></div>'+
   '<div style="margin-top:12px"><a class="btn" href="#/exts">管理外部扩展</a></div></div>'+

  '<div class="card"><h3>MOTD 查询</h3><div class="sub">查询 Minecraft 服务器状态。文本 API 默认用 motd.txssb.cn;也可以换成你自己的接口。图片 API 留空时只发文字</div>'+
   '<div class="line"><div class="g"><b>启用 MOTD</b><span>关闭后 /motd 和 Agent 工具都不可用</span></div>'+sw(motd.enabled!==false,'data-t="agMotdEnabled"')+'</div>'+
   '<div class="fld"><label class="f">文本 API</label><input class="t mono" id="ag-motd-text" value="'+h(motd.textApi||'https://motd.txssb.cn/api/status')+'" placeholder="https://motd.txssb.cn/api/status"></div>'+
   '<div class="fld"><label class="f">图片 API(可留空)</label><input class="t mono" id="ag-motd-image" value="'+h(motd.imageApi||'')+'" placeholder="https://motd.txssb.cn/api/status_img"></div>'+
   '<div class="line"><div class="g"><b>发送图片</b><span>需要图片 API,且 QQ 富媒体上传成功;失败会自动退回文字</span></div>'+sw(motd.imageEnabled===true,'data-t="agMotdImage"')+'</div>'+
   '<div class="row"><div><label class="f">超时(毫秒)</label><input class="t" type="number" id="ag-motd-timeout" value="'+(motd.timeoutMs||8000)+'"></div>'+
   '<div><label class="f">测试地址</label><input class="t mono" id="ag-motd-host" placeholder="play.hypixel.net"></div></div>'+
   '<div style="display:flex;gap:10px;margin-top:12px"><button class="btn pri" id="ag-motd-save">保存</button><button class="btn" id="ag-motd-test">测试查询</button></div>'+
   '<div class="hint" style="margin-top:12px">文本 API 支持 ip / port 参数;示例接口返回 MOTD、版本、在线人数和延迟。图片 API 需要返回 image/*。</div></div>';
  bindAgent(v,d);
  loadAgentTools(v);
 }).catch(function(e){v.innerHTML='<div class="card"><div class="empty">'+h(e.message)+'</div></div>'});
}

function bindAgent(v,d){
 var s=(d&&d.settings)||{},se=s.search||{};
 function save(patch,btn){
  if(btn){btn.disabled=true;var t=btn.textContent;btn.textContent='保存中…'}
  api('/settings',{method:'POST',body:patch}).then(function(r){toast(r&&r.note?r.note:'已保存');S.settings=null})
   .catch(function(e){toast(e.message)})
   .then(function(){if(btn){btn.disabled=false;btn.textContent=t}});
 }
 function headers(sel){try{return v.querySelector(sel).value.trim()?JSON.parse(v.querySelector(sel).value):{}}catch(e){toast('请求头不是合法的 JSON');throw e}}
 v.querySelector('#ag-llm-save').onclick=function(){
  var hh;try{hh=headers('#ag-llm-headers')}catch(e){return}
  save({llm:{baseUrl:v.querySelector('#ag-llm-url').value.trim(),apiKey:v.querySelector('#ag-llm-key').value.trim(),
   model:v.querySelector('#ag-llm-model').value.trim(),headers:hh,reasoningEffort:v.querySelector('#ag-llm-effort').value,
   deepThinking:v.querySelector('#ag-llm-think').value==='1',timeLimitEnabled:v.querySelector('#ag-llm-limit').value==='1',
   maxSeconds:Math.max(5,Number(v.querySelector('#ag-llm-secs').value)||600)},
   dashboard:{url:v.querySelector('#ag-llm-dash').value.trim()}},this)};
 v.querySelector('#ag-llm-list').onclick=function(){var b=this;b.disabled=true;b.textContent='获取中…';
  var hh;try{hh=headers('#ag-llm-headers')}catch(e){b.disabled=false;b.textContent='模型列表';return}
  api('/models',{method:'POST',body:{baseUrl:v.querySelector('#ag-llm-url').value.trim(),apiKey:v.querySelector('#ag-llm-key').value.trim(),headers:hh}})
   .then(function(r){
    v.querySelector('#ag-llm-models').innerHTML='<label class="f">接口返回的模型(点击选用)</label><div>'+
     r.models.map(function(x){return '<span class="chip" data-am="'+h(x)+'" style="cursor:pointer">'+h(x)+'</span>'}).join('')+'</div>';
    v.querySelectorAll('[data-am]').forEach(function(c){c.onclick=function(){v.querySelector('#ag-llm-model').value=c.dataset.am;toast('已填入 '+c.dataset.am)}});
   }).catch(function(e){toast(e.message)}).then(function(){b.disabled=false;b.textContent='模型列表'})};
 v.querySelector('#ag-llm-test').onclick=function(){var b=this;b.disabled=true;b.textContent='测试中…';
  var hh;try{hh=headers('#ag-llm-headers')}catch(e){b.disabled=false;b.textContent='测试';return}
  api('/test-llm',{method:'POST',body:{baseUrl:v.querySelector('#ag-llm-url').value.trim(),apiKey:v.querySelector('#ag-llm-key').value.trim(),headers:hh,model:v.querySelector('#ag-llm-model').value.trim()}})
   .then(function(r){modal('Agent 测试','<pre class="code">'+h(JSON.stringify(r,null,2))+'</pre>','<button class="btn" data-x>关闭</button>').querySelector('[data-x]').onclick=function(){this.closest('.modal').remove()}})
   .catch(function(e){toast(e.message)}).then(function(){b.disabled=false;b.textContent='测试'})};
 v.querySelector('#ag-se-save').onclick=function(){var hh;try{hh=headers('#ag-se-headers')}catch(e){return}
  var mv=v.querySelector('#ag-se-map').value.trim(),mm={results:'',title:'',url:'',snippet:'',content:''};
  if(mv){try{mm=JSON.parse(mv)}catch(e){toast('返回结构映射不是合法 JSON');return}}
  save({search:{baseUrl:v.querySelector('#ag-se-base').value.trim(),key:v.querySelector('#ag-se-key').value.trim(),
   searchPath:v.querySelector('#ag-se-spath').value.trim()||'/search',readerPath:v.querySelector('#ag-se-rpath').value.trim()||'/reader',
   results:Math.max(1,Math.min(10,Number(v.querySelector('#ag-se-results').value)||5)),readerFormat:v.querySelector('#ag-se-format').value.trim(),
   headers:hh,response:mm}},this)};
 v.querySelector('#ag-se-test').onclick=function(){var b=this;b.disabled=true;b.textContent='测试中…';
  api('/test-search',{method:'POST',body:{query:'今天有什么新闻'}}).then(function(r){
   modal('搜索测试结果','<pre class="code">'+h(JSON.stringify(r,null,2))+'</pre>','<button class="btn" data-x>关闭</button>').querySelector('[data-x]').onclick=function(){this.closest('.modal').remove()};
  }).catch(function(e){toast(e.message)}).then(function(){b.disabled=false;b.textContent='测试搜索'})};
 v.querySelector('#ag-persona-save').onclick=function(){save({persona:v.querySelector('#ag-persona').value},this)};
 v.querySelector('#ag-workflow-save').onclick=function(){save({llm:{workflow:v.querySelector('#ag-workflow').value}},this)};
 v.querySelector('[data-t="agSeEnabled"]').onclick=function(){this.classList.toggle('on');save({search:{enabled:this.classList.contains('on')}})};
 v.querySelector('[data-t="agSeMerge"]').onclick=function(){this.classList.toggle('on');save({search:{mergeReader:this.classList.contains('on')}})};
 v.querySelector('[data-t="agVision"]').onclick=function(){this.classList.toggle('on')};
 v.querySelector('[data-mod="audio"]').onclick=function(){this.classList.toggle('on')};
 v.querySelector('#ag-mod-save').onclick=function(){
  var vision=v.querySelector('[data-t="agVision"]').classList.contains('on');
  var arr=['text'];if(vision)arr.push('image');
  if(v.querySelector('[data-mod="audio"]').classList.contains('on'))arr.push('audio');
  save({agent:{modalities:arr,vision:vision}},this)};
 v.querySelector('[data-t="agMotdEnabled"]').onclick=function(){this.classList.toggle('on')};
 v.querySelector('[data-t="agMotdImage"]').onclick=function(){this.classList.toggle('on')};
 v.querySelector('#ag-motd-save').onclick=function(){
  save({motd:{
   enabled:v.querySelector('[data-t="agMotdEnabled"]').classList.contains('on'),
   imageEnabled:v.querySelector('[data-t="agMotdImage"]').classList.contains('on'),
   textApi:v.querySelector('#ag-motd-text').value.trim(),
   imageApi:v.querySelector('#ag-motd-image').value.trim(),
   timeoutMs:Math.max(2000,Math.min(30000,Number(v.querySelector('#ag-motd-timeout').value)||8000)),
  }},this)};
 v.querySelector('#ag-motd-test').onclick=function(){var b=this;var host=v.querySelector('#ag-motd-host').value.trim();
  if(!host){toast('先填一个测试地址');return}
  b.disabled=true;b.textContent='查询中…';
  api('/test-motd',{method:'POST',body:{host:host}}).then(function(r){
   modal('MOTD 测试','<pre class="code">'+h(r.text||'')+'</pre><details style="margin-top:10px"><summary class="small dim">原始 JSON</summary><pre class="code">'+h(JSON.stringify(r.result,null,2))+'</pre></details>','<button class="btn" data-x>关闭</button>')
    .querySelector('[data-x]').onclick=function(){this.closest('.modal').remove()};
  }).catch(function(e){toast(e.message)}).then(function(){b.disabled=false;b.textContent='测试查询'})};
}
function loadAgentTools(v){
 api('/exts').then(function(d){
  var builtin=d.builtin||[];
  var box=v.querySelector('#ag-tools');if(!box)return;
  box.innerHTML=builtin.map(function(b){
   return '<div class="line"><div class="g"><b>'+h(b.name)+'</b><span>'+h(b.description||'')+'</span>'+
    '<span class="mono" style="font-size:11px">'+h((b.tools||[]).join(', '))+'</span></div>'+sw(b.enabled,'data-agtool="'+h(b.id)+'"')+'</div>';
  }).join('');
  box.querySelectorAll('[data-agtool]').forEach(function(n){n.onclick=function(){
   api('/exts/toggle',{method:'POST',body:{id:n.dataset.agtool,enabled:!n.classList.contains('on')}})
    .then(function(){n.classList.toggle('on');toast('已更新')}).catch(function(e){toast(e.message)})}});
 }).catch(function(e){var box=v.querySelector('#ag-tools');if(box)box.innerHTML='<div class="empty">'+h(e.message)+'</div>'});
}
function pageSettings(){
 setTitle('设置');
 var v=el('view');v.innerHTML='<div class="empty">加载中…</div>';
 loadSettings(true).then(function(d){
  var s=d.settings,llm=s.llm,se=s.search,qq=s.qq,dep=s.deploy,lg=s.logs,gr=s.groups,ad=s.admin,ag=s.agent||{},ui=s.ui||{},dash=s.dashboard||{},upd=s.update||{};
  var headers=function(o){return h(JSON.stringify(o||{},null,0))};
  var mapObj=se.response||{},mapText=Object.keys(mapObj).some(function(k){return mapObj[k]})?JSON.stringify(mapObj):'';
  v.innerHTML=
  '<div class="card"><h3>Agent 配置</h3><div class="sub">AI 接口、联网搜索、人设、工作流、工具和模态已经移到独立的「Agent 配置」页,主设置只保留机器人、部署和日志</div><a class="btn pri" href="#/agent">打开 Agent 配置</a></div>'+

  '<div class="card"><h3>QQ 机器人</h3><div class="sub">连接方式可以随时切换</div>'+
   '<div class="row"><div><label class="f">APPID</label><input class="t mono" id="qq-id" value="'+h(qq.appId)+'"></div>'+
   '<div><label class="f">APP Secret</label><input class="t mono" id="qq-secret" value="'+h(qq.appSecret)+'"></div></div>'+
   '<div class="fld" style="margin-top:13px"><label class="f">运行环境</label><select class="t" id="qq-env">'+
    '<option value="prod"'+(qq.sandbox?'':' selected')+'>正式环境(机器人已上线)</option>'+
    '<option value="sandbox"'+(qq.sandbox?' selected':'')+'>沙箱环境(还在开发调试)</option></select></div>'+
   '<div class="fld"><label class="f">连接方式</label><select class="t" id="qq-mode">'+
    '<option value="webhook"'+(qq.mode==='webhook'?' selected':'')+'>WebHook(默认:闲时休眠不占额度;需在开放平台填回调地址)</option>'+
    '<option value="websocket"'+(qq.mode!=='webhook'?' selected':'')+'>WebSocket(无需开放平台配置;常驻连接持续消耗 DO 时长)</option></select></div>'+
   '<div class="fld"><label class="f">结果投递方式</label><select class="t" id="qq-delivery">'+
    '<option value="auto"'+(qq.answerDelivery!=='active'?' selected':'')+'>自动(被动窗口内被动回复,超时改用主动消息)</option>'+
    '<option value="active"'+(qq.answerDelivery==='active'?' selected':'')+'>总是主动消息(耗每月额度,慎用)</option></select></div>'+
   '<div class="line"><div class="g"><b>Markdown 消息</b><span>帮助和 AI 回复用 Markdown 发送;失败自动退回纯文本(群聊 Markdown 可能需要开放平台权限)</span></div>'+sw(qq.markdown===true,'data-t="qqMarkdown"')+'</div>'+
   '<div class="fld" id="qq-hook" style="display:'+(qq.mode==='webhook'?'block':'none')+'">'+
    '<label class="f">回调地址(填到 QQ 开放平台 → 开发设置 → 回调配置)</label>'+
    '<div class="row"><div><input class="t mono" id="qq-cb" value="'+h(d.callbackUrl)+'"></div>'+
    '<div style="flex:0 0 110px"><button class="btn" id="qq-copy">复制</button></div></div></div>'+
   '<button class="btn pri" id="qq-save">保存并应用</button> <span class="small dim" id="qq-state">'+h(d.modeText||'')+'</span></div>'+

  '<div class="card"><h3>群聊权限</h3><div class="sub">控制哪些群可以使用机器人</div>'+
   '<div class="line"><div class="g"><b>允许所有群聊</b><span>开启后任何拉过机器人的群都能用,并自动加入列表</span></div>'+sw(gr.allowAll,'data-t="allowAll"')+'</div>'+
   '<div style="margin-top:12px" id="gr-list">'+groupRows(gr.list)+'</div>'+
   '<div class="row" style="margin-top:12px"><div><input class="t mono" id="gr-add" placeholder="输入群聊 openID"></div>'+
   '<div style="flex:0 0 110px"><button class="btn" id="gr-addb">添加</button></div></div>'+
   '<div class="hint" style="margin-top:12px">在群里 @机器人 发送 <span class="mono">/查信息</span> 就能看到这个群的 openID。</div></div>'+

  '<div class="card"><h3>管理员</h3><div class="sub">除面板账号外,谁可以在群里管理机器人</div>'+
   '<div class="line"><div class="g"><b>群管理员即机器人管理员</b><span>群主/管理员在群里可以直接使用管理指令</span></div>'+sw(ad.groupAdmins,'data-t="groupAdmins"')+'</div>'+
   '<div style="margin-top:12px" id="ad-list">'+adminRows(ad.openIds)+'</div>'+
   '<div class="row" style="margin-top:12px"><div><input class="t mono" id="ad-add" placeholder="输入用户 openID"></div>'+
   '<div style="flex:0 0 110px"><button class="btn" id="ad-addb">添加</button></div></div></div>'+

  '<div class="card"><h3>部署参数</h3><div class="sub">KV 空间分配:固定保留 + 每项目保底 + 动态池(按访问量优先分配)</div>'+
   '<div class="fld"><label class="f">站点域名(部署链接显示与复制用的完整网址)</label>'+
   '<div class="row"><div><input class="t mono" id="site-base" value="'+h((s.site&&s.site.publicBaseUrl)||'')+'" placeholder="https://ai.example.com"></div>'+
   '<div style="flex:0 0 130px"><button class="btn" id="site-get">获取当前网址</button></div></div></div>'+
   '<div class="row"><div><label class="f">默认有效期(分钟)</label><input class="t" type="number" id="dp-ttl" value="'+dep.ttlSeconds/60+'"></div>'+
   '<div><label class="f">每次续期(分钟)</label><input class="t" type="number" id="dp-ext" value="'+dep.extendSeconds/60+'"></div>'+
   '<div><label class="f">同时可部署项目数</label><input class="t" type="number" id="dp-max" value="'+dep.maxProjects+'"></div></div>'+
   '<div class="row" style="margin-top:13px"><div><label class="f">固定保留(MB)</label><input class="t" type="number" id="dp-res" value="'+Math.round(dep.reserveBytes/1048576)+'"></div>'+
   '<div><label class="f">每项目保底(MB)</label><input class="t" type="number" id="dp-per" value="'+Math.round(dep.perProjectBytes/1048576)+'"></div>'+
   '<div><label class="f">项目数据配额(KB)</label><input class="t" type="number" id="dp-data" value="'+Math.round(dep.dataQuotaBytes/1024)+'"></div>'+
   '<div><label class="f">每日部署上限(次)</label><input class="t" type="number" id="dp-day" value="'+dep.maxPerDay+'"></div></div>'+
   '<div style="margin-top:13px"><div class="line"><div class="g"><b>允许项目存数据</b><span>关闭后部署的页面无法使用 /__data/ 接口</span></div>'+sw(dep.allowData!==false,'data-t="allowData"')+'</div></div>'+
   '<div class="hint" style="margin-top:12px">KV 免费额度约 1 GB。当前容量上限:最多 '+d.quota.capacity+' 个项目。'+
   (d.quota.clamped?'<br><b style="color:#b45309">注意:你设置的数量超过容量,保存时会自动降到 '+d.quota.capacity+'。</b>':'')+'</div>'+
   '<div style="margin-top:12px"><button class="btn pri" id="dp-save">保存</button></div></div>'+

  '<div class="card"><h3>部署架构</h3><div class="sub">决定机器人能把网页部署成什么形态,改完立刻生效</div>'+
   '<div class="line"><div class="g"><b>静态网页</b><span>纯 HTML/CSS/JS 文件,加上 ./__data 简易存储</span></div>'+sw((ag.architectures||['html']).indexOf('html')>=0,'data-t="archHtml"')+'</div>'+
   '<div class="line"><div class="g"><b>预制后端接口</b><span>页面可以调用「模块」页里勾了「站点后端」的模块</span></div>'+sw((ag.architectures||[]).indexOf('prefab')>=0,'data-t="archPrefab"')+'</div>'+
   '<div class="line"><div class="g"><b>自定义后端</b><span>页面里放 _backend.js,由沙盒执行,每站带独立数据存储</span></div>'+sw((ag.architectures||[]).indexOf('custom')>=0,'data-t="archCustom"')+'</div>'+
   '<div class="hint" style="margin-top:12px">开启后,页面里 fetch("/api/…") 会先找同名的预制模块,再找页面所属站点的 _backend.js;有每分钟频率限制。</div>'+
   '<div class="line"><div class="g"><b>部署前确认</b><span>AI 部署先生成确认链接,管理员点「确认部署」后才真正创建</span></div>'+sw(dep.confirm===true,'data-t="deployConfirm"')+'</div></div>'+

  '<div class="card"><h3>日志</h3><div class="sub">调试模式会记录更详细的过程,占用更多存储</div>'+
   '<div class="line"><div class="g"><b>调试模式</b><span>记录每次请求、工具参数、上游原始返回</span></div>'+sw(lg.debug,'data-t="debug"')+'</div>'+
   '<div class="row" style="margin-top:13px"><div><label class="f">保留天数</label><input class="t" type="number" id="lg-days" value="'+lg.retentionDays+'"></div>'+
   '<div><label class="f">最多条数</label><input class="t" type="number" id="lg-max" value="'+lg.maxRows+'"></div></div>'+
   '<div style="margin-top:12px"><button class="btn pri" id="lg-save">保存</button> <button class="btn" id="lg-clean">立即清理</button></div></div>'+

  '<div class="card"><h3>界面</h3><div class="sub">V2 是浮动玻璃面板:柔和渐变背景、圆角悬浮卡片、可切换主题色。切换后整页刷新。</div>'+
   '<div class="row"><div><label class="f">面板版本</label><select class="t" id="ui-version">'+
    '<option value="v1"'+(ui.panelVersion!=='v2'?' selected':'')+'>V1 · 经典紧凑</option>'+
    '<option value="v2"'+(ui.panelVersion==='v2'?' selected':'')+'>V2 · 浮动玻璃</option></select></div>'+
   '<div><label class="f">主题色</label><select class="t" id="ui-accent">'+
    ['blue','purple','green','pink','amber'].map(function(x){return '<option value="'+x+'"'+((ui.accent||'blue')===x?' selected':'')+'>'+x+'</option>'}).join('')+
   '</select></div></div>'+
   '<div class="hint" style="margin-top:12px">V2 的首页在「首页配置」里改;主题色只影响面板,V2 下生效。</div>'+
   '<div style="margin-top:12px"><button class="btn pri" id="ui-save">保存并刷新</button></div></div>'+

  '<div class="card"><h3>更新</h3><div class="sub">检查 GitHub 仓库的最新版本;配置 Cloudflare Deploy Hook 后可以一键触发重新构建。Worker 不能在运行时替换自己的代码,真正更新仍由 Cloudflare 构建完成。</div>'+
   '<div class="line"><div class="g"><b>自动检查更新</b><span>登录面板后检查一次;关闭后不再自动检查</span></div>'+sw(upd.check!==false,'data-t="updateCheck"')+'</div>'+
   '<div class="fld"><label class="f">GitHub 仓库</label><input class="t mono" id="upd-repo" value="'+h(upd.repo||'MN-LKs/NOMO-QQBot')+'" placeholder="owner/repo"></div>'+
   '<div class="fld"><label class="f">Cloudflare Deploy Hook(可留空)</label><input class="t mono" id="upd-hook" value="'+h(upd.deployHook||'')+'" placeholder="https://api.cloudflare.com/client/v4/pages/webhooks/deploy_hooks/..."></div>'+
   '<div style="display:flex;gap:10px;margin-top:12px"><button class="btn pri" id="upd-check">检查更新</button><button class="btn" id="upd-save">保存</button></div>'+
   '<div id="upd-result" class="hint" style="margin-top:12px">当前版本 '+h(ME.appVersion||'4.1.0')+'</div></div>';
  bindSettings(v);
 }).catch(function(e){v.innerHTML='<div class="card"><div class="empty">'+h(e.message)+'</div></div>'});
}
function groupRows(list){
 if(!list||!list.length)return '<div class="hint">还没有添加群聊。开启「允许所有群聊」后会自动收集。</div>';
 return '<table><thead><tr><th>群聊 openID</th><th>添加时间</th><th style="width:90px"></th></tr></thead><tbody>'+
  list.map(function(g){return '<tr><td class="mono small">'+h(g.openid)+'</td><td class="small dim">'+ts2s(g.addedAt)+
   '</td><td style="text-align:right"><button class="btn sm bad" data-grdel="'+h(g.openid)+'">移除</button></td></tr>'}).join('')+'</tbody></table>';
}
function adminRows(list){
 if(!list||!list.length)return '<div class="hint">还没有单独添加管理员 openID。</div>';
 return '<table><thead><tr><th>用户 openID</th><th>添加时间</th><th style="width:90px"></th></tr></thead><tbody>'+
  list.map(function(g){return '<tr><td class="mono small">'+h(g.openid)+'</td><td class="small dim">'+ts2s(g.addedAt)+
   '</td><td style="text-align:right"><button class="btn sm bad" data-addel="'+h(g.openid)+'">移除</button></td></tr>'}).join('')+'</tbody></table>';
}
function jparse(t,fb){try{return t.trim()?JSON.parse(t):fb}catch(e){toast('请求头不是合法的 JSON');throw e}}
function bindSettings(v){
 function save(patch,btn){
  if(btn){btn.disabled=true;var t=btn.textContent;btn.textContent='保存中…'}
  api('/settings',{method:'POST',body:patch}).then(function(r){toast(r&&r.note?r.note:'已保存');S.settings=null;loadSettings(true)})
   .catch(function(e){toast(e.message)})
   .then(function(){if(btn){btn.disabled=false;btn.textContent=t}});
 }
 if(v.querySelector('#llm-save'))v.querySelector('#llm-save').onclick=function(){var b=this;
  var hh;try{hh=jparse(v.querySelector('#llm-headers').value,{})}catch(e){return}
  save({llm:{baseUrl:v.querySelector('#llm-url').value.trim(),apiKey:v.querySelector('#llm-key').value.trim(),
   model:v.querySelector('#llm-model').value.trim(),headers:hh,reasoningEffort:v.querySelector('#llm-effort').value,
   deepThinking:v.querySelector('#llm-think').value==='1',
   timeLimitEnabled:v.querySelector('#llm-limit').value==='1',
   maxSeconds:Math.max(5,Number(v.querySelector('#llm-secs').value)||600)},
   dashboard:{url:v.querySelector('#llm-dash').value.trim()}},b)};
 if(v.querySelector('#llm-list'))v.querySelector('#llm-list').onclick=function(){var b=this;b.disabled=true;b.textContent='获取中…';
  var hh;try{hh=jparse(v.querySelector('#llm-headers').value,{})}catch(e){b.disabled=false;b.textContent='获取模型列表';return}
  api('/models',{method:'POST',body:{baseUrl:v.querySelector('#llm-url').value.trim(),apiKey:v.querySelector('#llm-key').value.trim(),headers:hh}})
  .then(function(r){
   if(!r.models.length){toast('接口没有返回模型');return}
   v.querySelector('#llm-models').innerHTML='<label class="f">接口返回的模型(点击选用)</label><div>'+
    r.models.map(function(x){return '<span class="chip" data-m="'+h(x)+'" style="cursor:pointer">'+h(x)+'</span>'}).join('')+'</div>';
   v.querySelectorAll('[data-m]').forEach(function(c){c.onclick=function(){v.querySelector('#llm-model').value=c.dataset.m;toast('已填入 '+c.dataset.m)}});
  }).catch(function(e){toast(e.message)}).then(function(){b.disabled=false;b.textContent='获取模型列表'})};
 if(v.querySelector('#llm-test'))v.querySelector('#llm-test').onclick=function(){testLLM(v)};
 if(v.querySelector('#se-save'))v.querySelector('#se-save').onclick=function(){var b=this;var hh;try{hh=jparse(v.querySelector('#se-headers').value,{})}catch(e){return}
  var mv=v.querySelector('#se-map').value.trim(),mm={results:'',title:'',url:'',snippet:'',content:''};
  if(mv){try{mm=JSON.parse(mv)}catch(e){toast('返回结构映射不是合法 JSON');return}}
  save({search:{baseUrl:v.querySelector('#se-base').value.trim(),key:v.querySelector('#se-key').value.trim(),
    searchPath:v.querySelector('#se-spath').value.trim()||'/search',readerPath:v.querySelector('#se-rpath').value.trim()||'/reader',
    results:Math.max(1,Math.min(10,Number(v.querySelector('#se-results').value)||5)),
    readerFormat:v.querySelector('#se-format').value.trim(),headers:hh,response:mm}},b)};
 if(v.querySelector('#se-test'))v.querySelector('#se-test').onclick=function(){var b=this;b.disabled=true;b.textContent='测试中…';
  api('/test-search',{method:'POST',body:{query:'今天有什么新闻'}}).then(function(r){
   modal('搜索测试结果','<pre class="code">'+h(JSON.stringify(r,null,2))+'</pre>','<button class="btn" data-x>关闭</button>')
    .querySelector('[data-x]').onclick=function(){this.closest('.modal').remove()};
  }).catch(function(e){modal('搜索测试失败','<div class="hint" style="border-color:#fecaca;color:#b91c1c">'+h(e.message)+'</div>','<button class="btn" data-x>关闭</button>')
   .querySelector('[data-x]').onclick=function(){this.closest('.modal').remove()}})
  .then(function(){b.disabled=false;b.textContent='测试搜索'})};
 if(v.querySelector('#persona-save'))v.querySelector('#persona-save').onclick=function(){save({persona:v.querySelector('#persona').value},this)};
 v.querySelector('#qq-mode').onchange=function(){v.querySelector('#qq-hook').style.display=this.value==='webhook'?'block':'none'};
 v.querySelector('#qq-copy').onclick=function(){var i=v.querySelector('#qq-cb');i.select();
  try{navigator.clipboard.writeText(i.value);toast('已复制')}catch(e){document.execCommand('copy');toast('已复制')}};
 v.querySelector('#qq-save').onclick=function(){var b=this;b.disabled=true;b.textContent='应用中…';
  api('/settings',{method:'POST',body:{qq:{appId:v.querySelector('#qq-id').value.trim(),
   appSecret:v.querySelector('#qq-secret').value.trim(),mode:v.querySelector('#qq-mode').value,
   sandbox:v.querySelector('#qq-env').value==='sandbox',
   answerDelivery:v.querySelector('#qq-delivery').value,
   markdown:v.querySelector('[data-t="qqMarkdown"]').classList.contains('on')}}})
  .then(function(r){toast(r.note||'已保存并应用');S.settings=null;render()})
  .catch(function(e){toast(e.message)}).then(function(){b.disabled=false;b.textContent='保存并应用'})};
 function tog(sel,path){var n=v.querySelector(sel);if(!n)return;n.onclick=function(){
  var on=!n.classList.contains('on');n.classList.toggle('on',on);
  var patch={};patch[path[0]]={};patch[path[0]][path[1]]=on;save(patch)}};
 tog('[data-t="allowAll"]',['groups','allowAll']);
 tog('[data-t="groupAdmins"]',['admin','groupAdmins']);
 tog('[data-t="qqMarkdown"]',['qq','markdown']);
 tog('[data-t="allowData"]',['deploy','allowData']);
 tog('[data-t="deployConfirm"]',['deploy','confirm']);
 tog('[data-t="updateCheck"]',['update','check']);
 tog('[data-t="debug"]',['logs','debug']);
 tog('[data-t="seEnabled"]',['search','enabled']);
 tog('[data-t="seMerge"]',['search','mergeReader']);
 var archArr=function(){var out=[];
  if(v.querySelector('[data-t="archHtml"]').classList.contains('on'))out.push('html');
  if(v.querySelector('[data-t="archPrefab"]').classList.contains('on'))out.push('prefab');
  if(v.querySelector('[data-t="archCustom"]').classList.contains('on'))out.push('custom');
  return out};
 ['archHtml','archPrefab','archCustom'].forEach(function(k){v.querySelector('[data-t="'+k+'"]').onclick=function(){
  var node=this,on=!node.classList.contains('on');
  node.classList.toggle('on',on);
  var arr=archArr();
  if(!arr.length){node.classList.toggle('on',true);toast('至少要保留一种架构');return}
  api('/settings',{method:'POST',body:{agent:{architectures:arr}}}).then(function(){toast('已保存')})
   .catch(function(e){toast(e.message);render()})}});
 v.querySelector('#gr-addb').onclick=function(){var id=v.querySelector('#gr-add').value.trim();if(!id)return;
  api('/groups',{method:'POST',body:{openid:id,action:'add'}}).then(function(){toast('已添加');render()}).catch(function(e){toast(e.message)})};
 v.querySelector('#ad-addb').onclick=function(){var id=v.querySelector('#ad-add').value.trim();if(!id)return;
  api('/admins',{method:'POST',body:{openid:id,action:'add'}}).then(function(){toast('已添加');render()}).catch(function(e){toast(e.message)})};
 v.querySelectorAll('[data-grdel]').forEach(function(b){b.onclick=function(){
  api('/groups',{method:'POST',body:{openid:b.dataset.grdel,action:'remove'}}).then(function(){toast('已移除');render()}).catch(function(e){toast(e.message)})}});
 v.querySelectorAll('[data-addel]').forEach(function(b){b.onclick=function(){
  api('/admins',{method:'POST',body:{openid:b.dataset.addel,action:'remove'}}).then(function(){toast('已移除');render()}).catch(function(e){toast(e.message)})}});
 v.querySelector('#dp-save').onclick=function(){var b=this;b.disabled=true;b.textContent='保存中…';
  api('/settings',{method:'POST',body:{deploy:{
   ttlSeconds:Math.max(60,Number(v.querySelector('#dp-ttl').value)*60||600),
   extendSeconds:Math.max(60,Number(v.querySelector('#dp-ext').value)*60||600),
   maxProjects:Math.max(1,Number(v.querySelector('#dp-max').value)||5),
   reserveBytes:Math.max(0,Number(v.querySelector('#dp-res').value)||0)*1048576,
   perProjectBytes:Math.max(1,Number(v.querySelector('#dp-per').value)||64)*1048576,
   dataQuotaBytes:Math.max(0,Number(v.querySelector('#dp-data').value)||0)*1024,
   maxPerDay:Math.max(1,Number(v.querySelector('#dp-day').value)||50)},
   site:{publicBaseUrl:v.querySelector('#site-base').value.trim()}}})
  .then(function(r){toast(r.note||'已保存');S.settings=null;render()})
  .catch(function(e){toast(e.message)}).then(function(){b.disabled=false;b.textContent='保存'})};
 v.querySelector('#site-get').onclick=function(){v.querySelector('#site-base').value=location.origin;toast('已填入当前网址,记得点保存')};
 v.querySelector('#lg-save').onclick=function(){save({logs:{retentionDays:Number(v.querySelector('#lg-days').value)||7,
  maxRows:Number(v.querySelector('#lg-max').value)||8000}},this)};
 v.querySelector('#lg-clean').onclick=function(){var b=this;b.disabled=true;
  api('/logs/cleanup',{method:'POST'}).then(function(r){toast('清理完成,剩余 '+r.count+' 条')}).catch(function(e){toast(e.message)})
  .then(function(){b.disabled=false})};
 v.querySelector('#ui-accent').onchange=function(){document.body.dataset.accent=this.value};
 v.querySelector('#ui-save').onclick=function(){var b=this;b.disabled=true;b.textContent='保存中…';
  api('/settings',{method:'POST',body:{ui:{panelVersion:v.querySelector('#ui-version').value,accent:v.querySelector('#ui-accent').value}}})
   .then(function(){location.reload()}).catch(function(e){toast(e.message);b.disabled=false;b.textContent='保存并刷新'})};
 v.querySelector('#upd-save').onclick=function(){var b=this;b.disabled=true;b.textContent='保存中…';
  api('/settings',{method:'POST',body:{update:{check:v.querySelector('[data-t="updateCheck"]').classList.contains('on'),
   repo:v.querySelector('#upd-repo').value.trim(),deployHook:v.querySelector('#upd-hook').value.trim()}}})
   .then(function(){toast('更新设置已保存');S.settings=null;b.disabled=false;b.textContent='保存'})
   .catch(function(e){toast(e.message);b.disabled=false;b.textContent='保存'})};
 v.querySelector('#upd-check').onclick=function(){var b=this;b.disabled=true;b.textContent='检查中…';
  api('/update/check').then(function(r){showUpdateInfo(r)}).catch(function(e){toast(e.message)})
   .then(function(){b.disabled=false;b.textContent='检查更新'})};
}
function testLLM(v){
 var url=v.querySelector('#llm-url').value.trim(),key=v.querySelector('#llm-key').value.trim();
 var hh;try{hh=jparse(v.querySelector('#llm-headers').value,{})}catch(e){return}
 var m=modal('测试模型','<div class="empty">正在获取模型列表…</div>','<button class="btn" data-x>关闭</button>');
 m.querySelector('[data-x]').onclick=function(){m.remove()};
 api('/models',{method:'POST',body:{baseUrl:url,apiKey:key,headers:hh}}).then(function(r){
  var bd=m.querySelector('.bd');
  bd.innerHTML='<div class="fld"><label class="f">选择要测试的模型</label><select class="t" id="tm">'+
   r.models.map(function(x){return '<option value="'+h(x)+'">'+h(x)+'</option>'}).join('')+'</select></div>'+
   '<div style="display:flex;gap:10px;margin-bottom:14px"><button class="btn pri" id="go">开始测试</button>'+
   '<button class="btn" id="copy" style="display:none">复制结果</button></div><div id="out"></div>';
  bd.querySelector('#go').onclick=function(){
   var b=this;b.disabled=true;b.textContent='测试中…';bd.querySelector('#out').innerHTML='<div class="empty">正在请求…</div>';
   api('/test-llm',{method:'POST',body:{baseUrl:url,apiKey:key,headers:hh,model:bd.querySelector('#tm').value}}).then(function(r){
    var ok1=r.chat&&r.chat.ok,ok2=r.tool&&r.tool.ok;
    bd.querySelector('#out').innerHTML=
     '<div class="line"><div class="g"><b>基础对话</b><span>'+h(r.chat&&r.chat.detail||'')+'</span></div>'+
      (ok1?'<span class="tag ok">通过</span>':'<span class="tag bad">失败</span>')+'</div>'+
     '<div class="line"><div class="g"><b>工具调用</b><span>'+h(r.tool&&r.tool.detail||'')+'</span></div>'+
      (ok2?'<span class="tag ok">通过</span>':'<span class="tag bad">失败</span>')+'</div>'+
     (r.chat&&r.chat.reply?'<div style="margin-top:12px"><label class="f">模型回复</label><pre class="code">'+h(r.chat.reply)+'</pre></div>':'')+
     (!ok1||!ok2?'<div style="margin-top:12px"><label class="f">详细报错</label><pre class="code">'+h(JSON.stringify(r,null,2))+'</pre></div>':'');
    var c=bd.querySelector('#copy');c.style.display='inline-block';
    c.onclick=function(){navigator.clipboard.writeText(JSON.stringify(r,null,2));toast('已复制')};
   }).catch(function(e){bd.querySelector('#out').innerHTML='<div class="hint" style="border-color:#fecaca;color:#b91c1c">'+h(e.message)+'</div>'})
   .then(function(){b.disabled=false;b.textContent='开始测试'})};
 }).catch(function(e){
  m.querySelector('.bd').innerHTML='<div class="hint" style="border-color:#fecaca;color:#b91c1c">获取模型列表失败:'+h(e.message)+'</div>'+
   '<div style="margin-top:12px"><button class="btn pri" id="still">仍然测试当前模型</button></div>';
  m.querySelector('#still').onclick=function(){m.remove();testLLM(v)};
 });
}
function pageLogs(){
 setTitle('日志');
 var v=el('view');v.innerHTML='<div class="empty">加载中…</div>';
 var lv=S.logLevel||'';
 api('/logs?limit=300'+(lv?'&level='+lv:'')).then(function(d){
  v.innerHTML='<div class="card"><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">'+
   '<div style="flex:1"><h3>运行日志</h3><div class="sub" style="margin:0">共 '+d.count+' 条 · 每 '+(d.retentionDays||7)+' 天自动清理,超过 '+(d.maxRows||8000)+' 条也会自动清理</div></div>'+
   '<div class="line" style="border:0;padding:0;gap:8px"><span class="small dim">调试模式</span>'+sw(d.debug,'data-dbg')+'</div>'+
   '<button class="btn sm" data-dl>下载</button><button class="btn sm" data-cp>复制</button><button class="btn sm bad" data-cl>清空</button></div>'+
   '<div style="margin:14px 0 10px;display:flex;gap:6px;flex-wrap:wrap">'+
    [['','全部'],['debug','debug'],['info','info'],['warn','warn'],['error','error']].map(function(x){
     return '<button class="btn sm'+((lv===x[0])?' pri':'')+'" data-lv="'+x[0]+'">'+x[1]+'</button>'}).join('')+
   '</div><div style="max-height:62vh;overflow:auto">'+
   (d.logs.length?d.logs.map(function(l){
    return '<div class="logline"><time>'+ts2s(l.ts)+'</time><span class="lv '+l.level+'">'+l.level+'</span>'+
     '<span class="ms">'+h(l.msg)+'</span></div>'}).join('')
    :'<div class="empty">没有日志</div>')+'</div></div>';
  v.querySelector('[data-dbg]').onclick=function(){var on=!this.classList.contains('on');
   api('/settings',{method:'POST',body:{logs:{debug:on}}}).then(function(){toast('调试模式已'+(on?'开启':'关闭'));render()})};
  v.querySelector('[data-dl]').onclick=function(){
   fetch('/administrator/api/logs/download',{headers:{'X-Requested-With':'nomo'}}).then(function(r){return r.blob()})
   .then(function(b){var a=document.createElement('a');a.href=URL.createObjectURL(b);
    a.download='nomo-logs-'+new Date().toISOString().slice(0,10)+'.txt';a.click();toast('已开始下载')})};
  v.querySelector('[data-cp]').onclick=function(){
   var txt=d.logs.map(function(l){return ts2s(l.ts)+' ['+l.level+'] '+l.msg}).join('\\n');
   navigator.clipboard.writeText(txt).then(function(){toast('已复制 '+d.logs.length+' 条')})};
  v.querySelector('[data-cl]').onclick=function(){confirmBox('清空日志','确认删除全部日志?此操作不可恢复。',function(){
   api('/logs',{method:'DELETE'}).then(function(){toast('已清空');render()})},true)};
  v.querySelectorAll('[data-lv]').forEach(function(b){b.onclick=function(){S.logLevel=b.dataset.lv;render()}});
 }).catch(function(e){v.innerHTML='<div class="card"><div class="empty">'+h(e.message)+'</div></div>'});
}
function pageExtHub(){
 setTitle('扩展管理');
 var v=el('view');
 var items=[
  ['mcp','MCP 设置','接入 Streamable HTTP / SSE 服务器,查看工具并逐个开关'],
  ['skills','技能','按触发词注入专项知识,支持粘贴 SKILL.md 自动解析'],
  ['exts','扩展','内置工具组开关 + 外部 HTTP 扩展'],
  ['modules','模块','预制后端 JS:Agent 工具 / 站点后端,可在线测试'],
 ];
 v.innerHTML='<div class="card"><h3>扩展管理</h3><div class="sub">MCP、技能、扩展、模块都收在这里;侧边栏只保留一个入口</div>'+
  '<div class="grid g2">'+items.map(function(it){
   return '<div style="border:1px solid var(--line);border-radius:14px;padding:16px;background:rgba(255,255,255,.45)">'+
    '<b style="font-size:15px">'+h(it[1])+'</b><p class="small dim" style="margin:6px 0 12px;line-height:1.7">'+h(it[2])+'</p>'+
    '<button class="btn sm pri" data-go="'+it[0]+'">打开'+h(it[1])+'</button></div>';
  }).join('')+'</div>'+
  '<div class="hint" style="margin-top:14px">这些页面仍然可以用地址直接访问,例如 #/mcp、#/skills、#/exts、#/modules。</div></div>';
 v.querySelectorAll('[data-go]').forEach(function(b){b.onclick=function(){go(b.dataset.go)}});
}
function pageMcp(){
 setTitle('MCP 设置');
 var v=el('view');v.innerHTML='<div class="empty">加载中…</div>';
 api('/mcp').then(function(d){
  v.innerHTML='<div class="card"><h3>MCP 服务器</h3><div class="sub">接入 Model Context Protocol 服务器,把它的工具挂给机器人使用</div>'+
   (d.servers.length?d.servers.map(function(s){
    var tools=s.tools||{list:[],enabled:[]};
    return '<div style="border:1px solid #e2e8f0;border-radius:9px;padding:14px;margin-bottom:12px">'+
     '<div style="display:flex;align-items:center;gap:10px"><div style="flex:1">'+
      '<b style="font-size:14px">'+h(s.name)+'</b> <span class="tag '+(s.enabled?'ok':'off')+'">'+(s.enabled?'已启用':'已停用')+'</span> '+
      '<span class="tag blue">'+h(s.transport)+'</span>'+
      '<br><span class="dim small mono">'+h(s.url)+'</span></div>'+
      '<div class="line" style="border:0;padding:0">'+sw(!!s.enabled,'data-en="'+h(s.id)+'"')+'</div>'+
      '<button class="btn sm" data-test="'+h(s.id)+'">测试</button>'+
      '<button class="btn sm bad" data-del="'+h(s.id)+'">删除</button></div>'+
     '<div class="small dim" style="margin-top:8px">'+(s.status||'未测试')+' · 工具 '+((tools.enabled||[]).length)+'/'+((tools.list||[]).length)+' 个已启用</div>'+
     (tools.list&&tools.list.length?'<div style="margin-top:10px">'+tools.list.map(function(t){
      var on=(tools.enabled||[]).indexOf(t.name)>=0;
      return '<div class="line"><div class="g"><b class="mono small">'+h(t.name)+'</b><span>'+h(t.description||'')+'</span></div>'+
       sw(on,'data-tool="'+h(s.id)+'|'+h(t.name)+'"')+'</div>'}).join('')+'</div>':'')+
    '</div>'}).join('')
   :'<div class="empty">还没有添加 MCP 服务器</div>')+'</div>'+
  '<div class="card"><h3>添加服务器</h3><div class="sub">支持 Streamable HTTP 与 SSE 两种传输</div>'+
   '<div class="row"><div><label class="f">名称</label><input class="t" id="m-name" placeholder="例如:文件助手"></div>'+
   '<div><label class="f">传输方式</label><select class="t" id="m-tr"><option value="auto">自动识别</option><option value="http">Streamable HTTP</option><option value="sse">SSE</option></select></div></div>'+
   '<div class="fld" style="margin-top:13px"><label class="f">服务器地址</label><input class="t mono" id="m-url" placeholder="https://example.com/mcp"></div>'+
   '<div class="fld"><label class="f">自定义请求头(JSON,可留空)</label><textarea class="t mono" id="m-hd" placeholder=\\'{"Authorization":"Bearer xxx"}\\'></textarea></div>'+
   '<button class="btn pri" id="m-add">添加并连接</button></div>';
  v.querySelector('#m-add').onclick=function(){var b=this;
   var hd;try{hd=jparse(v.querySelector('#m-hd').value,{})}catch(e){return}
   var name=v.querySelector('#m-name').value.trim(),url=v.querySelector('#m-url').value.trim();
   if(!name||!url){toast('名称和地址都要填');return}
   b.disabled=true;b.textContent='连接中…';
   api('/mcp',{method:'POST',body:{name:name,url:url,transport:v.querySelector('#m-tr').value,headers:hd}})
    .then(function(r){toast(r.note||'已添加');render()}).catch(function(e){toast(e.message)})
    .then(function(){b.disabled=false;b.textContent='添加并连接'})};
  v.querySelectorAll('[data-en]').forEach(function(n){n.onclick=function(){
   api('/mcp/'+n.dataset.en,{method:'POST',body:{enabled:!n.classList.contains('on')}}).then(function(){render()})}});
  v.querySelectorAll('[data-tool]').forEach(function(n){n.onclick=function(){
   var p=n.dataset.tool.split('|');
   api('/mcp/'+p[0],{method:'POST',body:{tool:p[1],on:!n.classList.contains('on')}}).then(function(){render()})}});
  v.querySelectorAll('[data-test]').forEach(function(b){b.onclick=function(){
   var old=b.textContent;b.disabled=true;b.textContent='连接中…';
   api('/mcp/'+b.dataset.test+'/test',{method:'POST'}).then(function(r){toast('连接成功,发现 '+r.count+' 个工具');render()})
    .catch(function(e){toast('连接失败:'+e.message)}).then(function(){b.disabled=false;b.textContent=old})}});
  v.querySelectorAll('[data-del]').forEach(function(b){b.onclick=function(){
   confirmBox('删除 MCP','确认删除这个服务器?',function(){api('/mcp/'+b.dataset.del,{method:'DELETE'})
    .then(function(){toast('已删除');render()})},true)}});
 }).catch(function(e){v.innerHTML='<div class="card"><div class="empty">'+h(e.message)+'</div></div>'});
}
var skillEdit=null,extEdit=null,modEdit=null,storeEdit=null;
function pageSkills(){
 setTitle('技能');
 var v=el('view');v.innerHTML='<div class="empty">加载中…</div>';
 api('/skills').then(function(d){
  var editing=skillEdit;
  v.innerHTML='<div class="card"><h3>技能</h3><div class="sub">写给机器人的专项知识:消息里提到触发词时,内容会注入系统提示词。不填触发词 = 每次都带上</div>'+
   (d.skills.length?d.skills.map(function(s){
    return '<div style="border:1px solid #e2e8f0;border-radius:9px;padding:14px;margin-bottom:12px">'+
     '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><div style="flex:1;min-width:200px">'+
      '<b style="font-size:14px">'+h(s.name)+'</b> '+
      '<span class="tag '+(s.enabled?'ok':'off')+'">'+(s.enabled?'已启用':'已停用')+'</span> '+
      (s.triggers&&s.triggers.length?'<span class="tag blue">'+h(s.triggers.join(' / '))+'</span>':'<span class="tag warn">每次注入</span>')+
      '<br><span class="small dim">'+h(s.description||'没有说明')+'</span></div>'+
      '<div class="line" style="border:0;padding:0">'+sw(s.enabled,'data-en="'+h(s.id)+'"')+'</div>'+
      '<button class="btn sm" data-edit="'+h(s.id)+'">编辑</button>'+
      '<button class="btn sm bad" data-del="'+h(s.id)+'">删除</button></div>'+
     '<div class="small dim" style="margin-top:9px;white-space:pre-wrap;max-height:76px;overflow:hidden">'+h(String(s.content||'').slice(0,240))+'</div></div>'}).join('')
    :'<div class="empty">还没有技能,下面建一个</div>')+'</div>'+
   '<div class="card"><h3>'+(editing?'编辑技能':'新建技能')+'</h3><div class="sub">也可以粘贴 SKILL.md 风格的文本,点「解析」自动填表</div>'+
   '<div class="fld"><label class="f">快速导入(粘贴后点解析,可留空)</label><textarea class="t mono" id="sk-doc" style="min-height:64px" placeholder="--- 开头写 name / triggers / description,正文跟在第二个 --- 之后"></textarea></div>'+
   '<div style="margin:-2px 0 13px"><button class="btn sm" id="sk-parse">解析并填入下方</button></div>'+
   '<div class="row"><div><label class="f">名称</label><input class="t" id="sk-name" value="'+(editing?h(editing.name):'')+'"></div>'+
   '<div><label class="f">触发词(逗号分隔;留空 = 每次都注入)</label><input class="t" id="sk-tr" value="'+(editing?h((editing.triggers||[]).join(',')):'')+'"></div></div>'+
   '<div class="fld" style="margin-top:13px"><label class="f">说明(可留空)</label><input class="t" id="sk-desc" value="'+(editing?h(editing.description||''):'')+'"></div>'+
   '<div class="fld"><label class="f">内容</label><textarea class="t mono" id="sk-content" style="min-height:160px">'+(editing?h(editing.content):'')+'</textarea></div>'+
   '<button class="btn pri" id="sk-save">'+(editing?'保存修改':'创建技能')+'</button> '+(editing?'<button class="btn" id="sk-cancel">取消编辑</button>':'')+'</div>';
  var parseDoc=function(t){
   var nl=String.fromCharCode(10);
   var src=String(t||'').trim(),meta={},body=src;
   if(src.indexOf('---')===0){
    var rest=src.slice(3),end=rest.indexOf(nl+'---');
    if(end>=0){
     var head=rest.slice(0,end);rest=rest.slice(end+4);
     if(rest.charAt(0)===nl)rest=rest.slice(1);
     body=rest.trim();
     var lines=head.split(nl);
     for(var i=0;i<lines.length;i++){
      var line=lines[i],p=line.indexOf(':'),q=line.indexOf('：');
      if(p<0||(q>=0&&q<p))p=q;
      if(p<0)continue;
      var k=line.slice(0,p).trim().toLowerCase(),val=line.slice(p+1).trim();
      if(k)meta[k]=val;
     }
    }
   }
   return {name:meta.name||'',description:meta.description||'',triggers:meta.triggers||'',content:body};
  };
  v.querySelector('#sk-parse').onclick=function(){
   var r=parseDoc(v.querySelector('#sk-doc').value);
   if(!r.name&&!r.content){toast('没有解析到内容');return}
   v.querySelector('#sk-name').value=r.name;
   v.querySelector('#sk-tr').value=r.triggers;
   v.querySelector('#sk-desc').value=r.description;
   v.querySelector('#sk-content').value=r.content;
   toast('已填入下方表单');
  };
  var byId=function(id){return d.skills.filter(function(x){return x.id===id})[0]||{}};
  v.querySelector('#sk-save').onclick=function(){var b=this;
   var name=v.querySelector('#sk-name').value.trim(),content=v.querySelector('#sk-content').value;
   if(!name){toast('请填名称');return}
   if(!content.trim()){toast('内容不能为空');return}
   b.disabled=true;
   api('/skills/save',{method:'POST',body:{skill:{id:editing?editing.id:'',name:name,description:v.querySelector('#sk-desc').value.trim(),triggers:v.querySelector('#sk-tr').value.trim(),content:content,enabled:editing?editing.enabled:true}}})
    .then(function(){toast('已保存');skillEdit=null;render()})
    .catch(function(e){toast(e.message)}).then(function(){b.disabled=false})};
  if(editing)v.querySelector('#sk-cancel').onclick=function(){skillEdit=null;render()};
  v.querySelectorAll('[data-en]').forEach(function(n){n.onclick=function(){
   var s=byId(n.dataset.en);
   api('/skills/save',{method:'POST',body:{skill:{id:s.id,name:s.name,description:s.description,triggers:s.triggers,content:s.content,enabled:!n.classList.contains('on')}}})
    .then(function(){render()}).catch(function(e){toast(e.message)})}});
  v.querySelectorAll('[data-edit]').forEach(function(b){b.onclick=function(){skillEdit=byId(b.dataset.edit);render()}});
  v.querySelectorAll('[data-del]').forEach(function(b){b.onclick=function(){
   confirmBox('删除技能','确认删除「'+h(byId(b.dataset.del).name||'')+'」?',function(){
    api('/skills/remove',{method:'POST',body:{id:b.dataset.del}}).then(function(){
     toast('已删除');if(skillEdit&&skillEdit.id===b.dataset.del)skillEdit=null;render()})},true)}});
 }).catch(function(e){v.innerHTML='<div class="card"><div class="empty">'+h(e.message)+'</div></div>'});
}
function pageExts(){
 setTitle('扩展');
 var v=el('view');v.innerHTML='<div class="empty">加载中…</div>';
 api('/exts').then(function(d){
  var editing=extEdit,builtin=d.builtin||[],external=d.external||[];
  v.innerHTML='<div class="card"><h3>内置工具组</h3><div class="sub">随机器人一起运行的工具,可以按需关掉。关掉后模型就看不到这些工具</div>'+
   builtin.map(function(b){
    return '<div class="line"><div class="g"><b>'+h(b.name)+'</b><span>'+h(b.description||'')+'</span>'+
     '<span class="mono" style="font-size:11px">'+h((b.tools||[]).join(', '))+'</span></div>'+sw(b.enabled,'data-bt="'+h(b.id)+'"')+'</div>'}).join('')+'</div>'+
   '<div class="card"><h3>外部扩展</h3><div class="sub">把任意 HTTP 接口配置成机器人的工具:填一份工具定义,模型就能调用它</div>'+
   (external.length?external.map(function(e){
    var n=Array.isArray(e.config&&e.config.tools)?e.config.tools.length:0;
    return '<div style="border:1px solid #e2e8f0;border-radius:9px;padding:14px;margin-bottom:12px">'+
     '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><div style="flex:1;min-width:200px">'+
      '<b style="font-size:14px">'+h(e.name)+'</b> <span class="tag mono">'+h(e.id)+'</span> <span class="tag '+(e.enabled?'ok':'off')+'">'+(e.enabled?'已启用':'已停用')+'</span>'+
      '<br><span class="small dim">'+h(e.description||'没有说明')+' · '+n+' 个工具</span></div>'+
      '<div class="line" style="border:0;padding:0">'+sw(e.enabled,'data-en="'+h(e.id)+'"')+'</div>'+
      '<button class="btn sm" data-edit="'+h(e.id)+'">编辑</button>'+
      '<button class="btn sm bad" data-del="'+h(e.id)+'">删除</button></div></div>'}).join('')
    :'<div class="empty">还没有外部扩展</div>')+'</div>'+
   '<div class="card"><h3>'+(editing?'编辑外部扩展':'添加外部扩展')+'</h3>'+
   '<div class="sub">config 里至少要有 tools 数组。每个工具的字段:name、description、endpoint(URL 里可用双花括号占位参数,如 {{city}})、method、headers、body、parameters、responsePath、timeoutMs</div>'+
   '<div class="row"><div><label class="f">扩展 ID(字母数字,会进工具名)</label><input class="t mono" id="ex-id" value="'+(editing?h(editing.id):'')+'"'+(editing?' disabled':'')+' placeholder="weather"></div>'+
   '<div><label class="f">名称</label><input class="t" id="ex-name" value="'+(editing?h(editing.name):'')+'"></div></div>'+
   '<div class="fld" style="margin-top:13px"><label class="f">说明(可留空)</label><input class="t" id="ex-desc" value="'+(editing?h(editing.description||''):'')+'"></div>'+
   '<div class="fld"><label class="f">工具定义(config JSON)</label><textarea class="t mono" id="ex-config" style="min-height:170px">'+(editing?h(JSON.stringify(editing.config,null,1)):'')+'</textarea>'+
   '<div class="hint" style="margin-top:8px">示例:{"tools":[{"name":"weather","description":"查天气","endpoint":"https://api.example.com/weather?city={{city}}","method":"GET","responsePath":"data.text"}]}</div></div>'+
   '<button class="btn pri" id="ex-save">'+(editing?'保存修改':'添加扩展')+'</button> '+(editing?'<button class="btn" id="ex-cancel">取消编辑</button>':'')+'</div>';
  var byId=function(id){return external.filter(function(x){return x.id===id})[0]||{}};
  v.querySelectorAll('[data-bt]').forEach(function(n){n.onclick=function(){
   api('/exts/toggle',{method:'POST',body:{id:n.dataset.bt,enabled:!n.classList.contains('on')}})
    .then(function(){render()}).catch(function(e){toast(e.message)})}});
  v.querySelectorAll('[data-en]').forEach(function(n){n.onclick=function(){
   var e=byId(n.dataset.en);
   api('/exts/save',{method:'POST',body:{ext:{id:e.id,name:e.name,description:e.description,config:e.config,enabled:!n.classList.contains('on')}}})
    .then(function(){render()}).catch(function(err){toast(err.message)})}});
  v.querySelectorAll('[data-edit]').forEach(function(b){b.onclick=function(){extEdit=byId(b.dataset.edit);render()}});
  v.querySelectorAll('[data-del]').forEach(function(b){b.onclick=function(){
   confirmBox('删除扩展','确认删除「'+h(byId(b.dataset.del).name||'')+'」这个外部扩展?',function(){
    api('/exts/remove',{method:'POST',body:{id:b.dataset.del}}).then(function(){
     toast('已删除');if(extEdit&&extEdit.id===b.dataset.del)extEdit=null;render()})},true)}});
  v.querySelector('#ex-save').onclick=function(){var b=this;
   var id=v.querySelector('#ex-id').value.trim(),name=v.querySelector('#ex-name').value.trim();
   if(!/^[a-zA-Z0-9_-]{2,32}$/.test(id)){toast('ID 用 2-32 位字母/数字/下划线/短横线');return}
   var cfg;
   try{cfg=v.querySelector('#ex-config').value.trim()?JSON.parse(v.querySelector('#ex-config').value):{}}catch(e){toast('config 不是合法 JSON');return}
   b.disabled=true;
   api('/exts/save',{method:'POST',body:{ext:{id:id,name:name||id,description:v.querySelector('#ex-desc').value.trim(),config:cfg,enabled:editing?editing.enabled:true}}})
    .then(function(){toast('已保存');extEdit=null;render()})
    .catch(function(e){toast(e.message)}).then(function(){b.disabled=false})};
  if(editing)v.querySelector('#ex-cancel').onclick=function(){extEdit=null;render()};
 }).catch(function(e){v.innerHTML='<div class="card"><div class="empty">'+h(e.message)+'</div></div>'});
}
function pageModules(){
 setTitle('模块');
 var v=el('view');v.innerHTML='<div class="empty">加载中…</div>';
 api('/modules').then(function(d){
  var editing=modEdit,mods=d.modules||[];
  v.innerHTML='<div class="card"><h3>预制模块</h3><div class="sub">管理员写的小段后端 JS,由内置沙盒解释器执行(不用 eval)。勾「Agent 工具」= 模型可直接调用;勾「站点后端」= 以后部署的页面可以调它</div>'+
   (mods.length?mods.map(function(m){
    var cp=m.callPoints||[];
    return '<div style="border:1px solid #e2e8f0;border-radius:9px;padding:14px;margin-bottom:12px">'+
     '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><div style="flex:1;min-width:200px">'+
      '<b style="font-size:14px">'+h(m.name)+'</b> <span class="tag mono">'+h(m.id)+'</span> '+
      (cp.indexOf('agent')>=0?'<span class="tag blue">Agent 工具</span> ':'')+
      (cp.indexOf('site')>=0?'<span class="tag blue">站点后端</span> ':'')+
      '<span class="tag '+(m.enabled?'ok':'off')+'">'+(m.enabled?'已启用':'已停用')+'</span>'+
      '<br><span class="small dim">'+h(m.description||'没有说明')+' · 超时 '+(m.timeoutMs||5000)+'ms'+(m.path?' · '+h(String(m.method||'ANY').toUpperCase())+' '+h(m.path):'')+'</span></div>'+
      '<div class="line" style="border:0;padding:0">'+sw(m.enabled,'data-en="'+h(m.id)+'"')+'</div>'+
      '<button class="btn sm" data-test="'+h(m.id)+'">测试</button>'+
      '<button class="btn sm" data-edit="'+h(m.id)+'">编辑</button>'+
      '<button class="btn sm bad" data-del="'+h(m.id)+'">删除</button></div></div>'}).join('')
    :'<div class="empty">还没有模块</div>')+'</div>'+
   '<div class="card"><h3>'+(editing?'编辑模块':'新建模块')+'</h3>'+
   '<div class="sub">代码顶层直接写语句,用 return 返回结果;可用 ctx.args、ctx.fetch(url)、ctx.log(值)。参数定义是 JSON Schema</div>'+
   '<div class="row"><div><label class="f">模块 ID(字母数字,进工具名)</label><input class="t mono" id="mo-id" value="'+(editing?h(editing.id):'')+'"'+(editing?' disabled':'')+' placeholder="echo_mod"></div>'+
   '<div><label class="f">名称</label><input class="t" id="mo-name" value="'+(editing?h(editing.name):'')+'"></div></div>'+
   '<div class="fld" style="margin-top:13px"><label class="f">说明(模型靠它决定什么时候调用)</label><input class="t" id="mo-desc" value="'+(editing?h(editing.description||''):'')+'"></div>'+
   '<div class="fld"><label class="f">参数定义(params JSON Schema,可留空)</label><textarea class="t mono" id="mo-params" style="min-height:70px">'+(editing&&editing.params&&Object.keys(editing.params).length?h(JSON.stringify(editing.params,null,1)):'')+'</textarea></div>'+
   '<div class="fld"><label class="f">代码</label><textarea class="t mono" id="mo-code" style="min-height:190px">'+(editing?h(editing.code):'')+'</textarea></div>'+
   '<div class="row"><div><label class="f">调用点</label><div style="padding-top:9px">'+
    '<label style="margin-right:16px;font-size:13px"><input type="checkbox" id="mo-agent"'+(editing&&(editing.callPoints||[]).indexOf('agent')>=0?' checked':'')+'> Agent 工具</label>'+
    '<label style="font-size:13px"><input type="checkbox" id="mo-site"'+(editing&&(editing.callPoints||[]).indexOf('site')>=0?' checked':'')+'> 站点后端</label></div></div>'+
   '<div><label class="f">超时(毫秒,500-30000)</label><input class="t" type="number" id="mo-timeout" value="'+(editing?(editing.timeoutMs||5000):5000)+'"></div></div>'+
   '<div class="row" style="margin-top:13px"><div><label class="f">HTTP 方法(站点后端用)</label><select class="t" id="mo-method">'+
    ['ANY','GET','POST','PUT','DELETE'].map(function(x){return '<option value="'+x+'"'+((editing?(editing.method||'ANY'):'ANY').toUpperCase()===x?' selected':'')+'>'+x+'</option>'}).join('')+'</select></div>'+
   '<div><label class="f">路径(站点后端用,如 /api/echo)</label><input class="t mono" id="mo-path" value="'+(editing?h(editing.path||''):'')+'"></div></div>'+
   '<button class="btn pri" id="mo-save" style="margin-top:14px">'+(editing?'保存修改':'创建模块')+'</button> '+(editing?'<button class="btn" id="mo-cancel">取消编辑</button>':'')+'</div>';
  var byId=function(id){return mods.filter(function(x){return x.id===id})[0]||{}};
  v.querySelectorAll('[data-en]').forEach(function(n){n.onclick=function(){
   var m=byId(n.dataset.en);
   api('/modules/save',{method:'POST',body:{module:{id:m.id,name:m.name,description:m.description,code:m.code,params:m.params,callPoints:m.callPoints,method:m.method,path:m.path,enabled:!n.classList.contains('on'),timeoutMs:m.timeoutMs}}})
    .then(function(){render()}).catch(function(e){toast(e.message)})}});
  v.querySelectorAll('[data-edit]').forEach(function(b){b.onclick=function(){modEdit=byId(b.dataset.edit);render()}});
  v.querySelectorAll('[data-del]').forEach(function(b){b.onclick=function(){
   confirmBox('删除模块','确认删除「'+h(byId(b.dataset.del).name||'')+'」?',function(){
    api('/modules/remove',{method:'POST',body:{id:b.dataset.del}}).then(function(){
     toast('已删除');if(modEdit&&modEdit.id===b.dataset.del)modEdit=null;render()})},true)}});
  v.querySelectorAll('[data-test]').forEach(function(b){b.onclick=function(){
   var old=b.textContent;b.disabled=true;b.textContent='运行中…';
   api('/modules/test',{method:'POST',body:{id:b.dataset.test,args:{}}}).then(function(r){
    var nl=String.fromCharCode(10);
    var txt=r.ok?('返回值:'+nl+String(JSON.stringify(r.value===undefined?null:r.value,null,2))):('运行失败:'+(r.error||''));
    if(r.logs&&r.logs.length)txt+=nl+nl+'日志:'+nl+r.logs.join(nl);
    var m=modal('模块测试 · '+b.dataset.test,'<pre class="code">'+h(txt)+'</pre>','<button class="btn" data-x>关闭</button>');
    m.querySelector('[data-x]').onclick=function(){m.remove()};
   }).catch(function(e){toast(e.message)}).then(function(){b.disabled=false;b.textContent=old})}});
  v.querySelector('#mo-save').onclick=function(){var b=this;
   var id=v.querySelector('#mo-id').value.trim(),name=v.querySelector('#mo-name').value.trim(),code=v.querySelector('#mo-code').value;
   if(!/^[a-zA-Z0-9_-]{2,32}$/.test(id)){toast('ID 用 2-32 位字母/数字/下划线/短横线');return}
   if(!code.trim()){toast('代码不能为空');return}
   var params;
   try{params=v.querySelector('#mo-params').value.trim()?JSON.parse(v.querySelector('#mo-params').value):{}}catch(e){toast('参数定义不是合法 JSON');return}
   var cps=[];
   if(v.querySelector('#mo-agent').checked)cps.push('agent');
   if(v.querySelector('#mo-site').checked)cps.push('site');
   b.disabled=true;
   api('/modules/save',{method:'POST',body:{module:{id:id,name:name||id,description:v.querySelector('#mo-desc').value.trim(),code:code,params:params,callPoints:cps,method:v.querySelector('#mo-method').value,path:v.querySelector('#mo-path').value.trim(),enabled:editing?editing.enabled:true,timeoutMs:Math.max(500,Math.min(30000,Number(v.querySelector('#mo-timeout').value)||5000))}}})
    .then(function(){toast('已保存');modEdit=null;render()})
    .catch(function(e){toast(e.message)}).then(function(){b.disabled=false})};
  if(editing)v.querySelector('#mo-cancel').onclick=function(){modEdit=null;render()};
 }).catch(function(e){v.innerHTML='<div class="card"><div class="empty">'+h(e.message)+'</div></div>'});
}
function pageStoreDetail(id){
 setTitle('存储详情');
 var v=el('view');v.innerHTML='<div class="empty">加载中…</div>';
 var prefix='',nextCursor=null;
 function load(cursor,append){
  var q='/storage/'+encodeURIComponent(id)+'?limit=100&prefix='+encodeURIComponent(prefix)+(cursor?'&cursor='+encodeURIComponent(cursor):'');
  api(q).then(function(d){draw(d,append,cursor)}).catch(function(e){v.innerHTML='<div class="card"><div class="empty">'+h(e.message)+'</div></div>'});
 }
 function fileRow(k){
  return '<div class="file" data-key="'+h(k.name)+'"><b style="word-break:break-all">'+h(k.name)+'</b>'+
   '<span class="dim small" style="margin-left:auto;flex:0 0 90px;text-align:right">'+bytes(k.size)+'</span>'+
   '<button class="btn sm" data-view="'+h(k.name)+'">查看</button>'+
   '<button class="btn sm bad" data-del="'+h(k.name)+'">删除</button></div>';
 }
 function bindRows(root){
  root.querySelectorAll('[data-view]').forEach(function(b){b.onclick=function(e){e.stopPropagation();viewStoreFile(b.dataset.view)}});
  root.querySelectorAll('[data-del]').forEach(function(b){b.onclick=function(e){e.stopPropagation();
   confirmBox('删除文件','确认删除「'+h(b.dataset.del)+'」?这个操作不可撤销。',function(){
    api('/storage/'+encodeURIComponent(id)+'/file',{method:'DELETE',body:{path:b.dataset.del}})
     .then(function(){toast('已删除');load()}).catch(function(err){toast(err.message)})},true)}});
 }
 function draw(d,append,cursor){
  var s=d.store||{},keys=d.keys||[];
  var pct=s.maxBytes?Math.min(100,Math.round(s.usedBytes/s.maxBytes*100)):0;
  var cap=s.maxBytes?bytes(s.maxBytes):'未设置';
  var pmax=s.providerMaxBytes?bytes(s.providerMaxBytes):'未知';
  if(append){
   var list=v.querySelector('#sd-list');if(list)list.insertAdjacentHTML('beforeend',keys.map(fileRow).join(''));
   bindRows(v);
  }else{
   v.innerHTML='<div class="card"><div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">'+
    '<div style="flex:1;min-width:220px"><h3 style="margin:0">'+h(s.name||id)+'</h3>'+
    '<div class="sub" style="margin:4px 0 0">'+h(s.kind)+' · 优先级 '+(s.priority||0)+(s.endpoint?' · '+h(s.endpoint):'')+(s.bucket?' / '+h(s.bucket):'')+'</div></div>'+
    '<button class="btn" id="sd-back">返回存储列表</button></div>'+
    '<div class="grid g4" style="margin-top:16px">'+
     '<div class="stat"><span>已用</span><b style="font-size:18px">'+bytes(s.usedBytes)+'</b><i>'+s.files+' 个文件</i></div>'+
     '<div class="stat"><span>用户上限</span><b style="font-size:18px">'+cap+'</b><i>写入时按这个限制</i></div>'+
     '<div class="stat"><span>服务商参考上限</span><b style="font-size:18px">'+pmax+'</b><i>按存储类型/端点识别</i></div>'+
     '<div class="stat"><span>占用比例</span><b style="font-size:18px">'+pct+'%</b><i>'+(s.available===false?'不可用':'可用')+'</i></div>'+
    '</div>'+
    '<div class="bar" style="margin-top:14px"><i class="'+(pct>=90?'bad':pct>=70?'warn':'')+'" style="width:'+pct+'%"></i></div>'+
    '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px">'+
     '<input class="t mono" id="sd-prefix" value="'+h(prefix)+'" placeholder="前缀筛选,例如 f/" style="flex:1;min-width:180px">'+
     '<button class="btn" id="sd-filter">筛选</button>'+
     '<button class="btn" id="sd-scan">重新扫描</button>'+
     '<button class="btn pri" id="sd-new">新建文本文件</button>'+
    '</div></div>'+
    '<div class="card"><h3>文件</h3><div class="sub">点击「查看」编辑文本文件;二进制文件给下载链接</div>'+
     '<div id="sd-list">'+(keys.length?keys.map(fileRow).join(''):'<div class="empty">这个前缀下没有文件</div>')+'</div>'+
     (d.cursor?'<div style="margin-top:12px"><button class="btn" id="sd-more">加载更多</button></div>':'')+'</div>';
   v.querySelector('#sd-back').onclick=function(){go('storage')};
   v.querySelector('#sd-filter').onclick=function(){prefix=v.querySelector('#sd-prefix').value.trim();nextCursor=null;load()};
   v.querySelector('#sd-scan').onclick=function(){var b=this;b.disabled=true;b.textContent='扫描中…';
    api('/storage/scan',{method:'POST',body:{id:id}}).then(function(r){toast('扫描完成:'+bytes(r.bytes)+' / '+r.files+' 个文件');load()})
     .catch(function(e){toast(e.message);b.disabled=false;b.textContent='重新扫描'})};
   v.querySelector('#sd-new').onclick=newStoreFile;
   if(v.querySelector('#sd-more'))v.querySelector('#sd-more').onclick=function(){load(d.cursor,true)};
   bindRows(v);
  }
  nextCursor=d.cursor||null;
 }
 function viewStoreFile(key){
  api('/storage/'+encodeURIComponent(id)+'/file?path='+encodeURIComponent(key)).then(function(f){
   var body;
   if(f.kind==='text'){
    body='<div class="hint" style="margin-bottom:10px">'+h(f.ct)+' · '+bytes(f.size)+'</div>'+
     '<textarea class="t mono" id="sd-content" style="min-height:340px">'+h(f.text)+'</textarea>'+
     '<div style="margin-top:10px"><button class="btn pri" id="sd-save">保存</button></div>';
   }else{
    body='<div class="hint">二进制文件('+h(f.ct)+', '+bytes(f.size)+'),不能直接编辑。</div>'+
     '<div style="margin-top:12px"><a class="btn pri" download="'+h(key.split('/').pop()||'file')+'" href="data:'+h(f.ct)+';base64,'+f.data+'">下载文件</a></div>';
   }
   var m=modal('文件 · '+key,body,'<button class="btn" data-x>关闭</button>');
   m.querySelector('[data-x]').onclick=function(){m.remove()};
   if(f.kind==='text')m.querySelector('#sd-save').onclick=function(){var b=this;b.disabled=true;b.textContent='保存中…';
    api('/storage/'+encodeURIComponent(id)+'/file',{method:'POST',body:{path:key,content:m.querySelector('#sd-content').value,encoding:'text',contentType:f.ct}})
     .then(function(){toast('已保存');m.remove();load()}).catch(function(e){toast(e.message);b.disabled=false;b.textContent='保存'})};
  }).catch(function(e){toast(e.message)});
 }
 function newStoreFile(){
  var m=modal('新建文本文件','<div class="fld"><label class="f">路径</label><input class="t mono" id="sd-path" placeholder="notes/hello.txt"></div>'+
   '<div class="fld"><label class="f">内容</label><textarea class="t mono" id="sd-new-content" style="min-height:220px"></textarea></div>',
   '<button class="btn" data-x>取消</button><button class="btn pri" data-ok>保存</button>');
  m.querySelector('[data-x]').onclick=function(){m.remove()};
  m.querySelector('[data-ok]').onclick=function(){var b=this;var path=m.querySelector('#sd-path').value.trim();
   if(!path){toast('请填写路径');return}
   b.disabled=true;b.textContent='保存中…';
   api('/storage/'+encodeURIComponent(id)+'/file',{method:'POST',body:{path:path,content:m.querySelector('#sd-new-content').value,encoding:'text',contentType:mimeGuess(path)}})
    .then(function(){toast('已保存');m.remove();load()}).catch(function(e){toast(e.message);b.disabled=false;b.textContent='保存'})};
 }
 load();
}
function mimeGuess(path){
 var n=String(path||'').toLowerCase();
 if(/\.html?$/.test(n))return 'text/html';
 if(/\.css$/.test(n))return 'text/css';
 if(/\.js$/.test(n))return 'text/javascript';
 if(/\.json$/.test(n))return 'application/json';
 if(/\.md$/.test(n))return 'text/markdown';
 if(/\.svg$/.test(n))return 'image/svg+xml';
 return 'text/plain';
}
function pageStorage(){
 setTitle('存储');
 var v=el('view');v.innerHTML='<div class="empty">加载中…</div>';
 api('/storage').then(function(d){
  var st=d.status||{},stores=st.stores||[],editing=storeEdit,bind=st.bindings||{};
  var tagOf=function(ok){return '<span class="tag '+(ok?'ok':'bad')+'">'+(ok?'已绑定':'未绑定')+'</span>'};
  v.innerHTML=
   ((st.warnings||[]).length?'<div class="card" style="border-color:#fecaca"><h3 style="color:#b91c1c">注意</h3>'+
    (st.warnings||[]).map(function(w){return '<div class="small" style="line-height:1.9;color:'+(w.level==='severe'?'#b91c1c':'#b45309')+'">· '+h(w.text)+'</div>'}).join('')+'</div>':'')+
   '<div class="card"><h3>绑定状态</h3><div class="sub">KV 和 R2 在 Cloudflare 后台绑定后自动出现在下面;S3 兼容存储(Filebase、Upstash、MinIO 等)在这里手动添加</div>'+
   '<div class="line"><div class="g"><b>D1 数据库(DB)</b><span>配置、日志、统计</span></div>'+tagOf(bind.db)+'</div>'+
   '<div class="line"><div class="g"><b>KV 命名空间(STORE)</b><span>部署文件的保底存储 / 缓存</span></div>'+tagOf(bind.kv)+'</div>'+
   '<div class="line"><div class="g"><b>R2 存储桶(R2)</b><span>绑了之后自动成为主存储</span></div>'+tagOf(bind.r2)+'</div>'+
   '<div class="line"><div class="g"><b>KV 镜像缓存</b><span>写入主存储时顺带往 KV 存一份,读取更稳</span></div>'+sw(st.cacheKV!==false,'data-cache')+'</div></div>'+
   '<div class="card"><h3>存储列表</h3><div class="sub">写入时按优先级从高到低,挑第一个「启用 + 可用 + 有余量」的存储</div>'+
   (stores.length?stores.map(function(s){
    var pct=s.maxBytes?Math.min(100,Math.round(s.usedBytes/s.maxBytes*100)):0;
    return '<div style="border:1px solid #e2e8f0;border-radius:9px;padding:14px;margin-bottom:12px">'+
     '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><div style="flex:1;min-width:200px">'+
      '<b style="font-size:14px">'+h(s.name)+'</b> '+
      '<span class="tag mono">'+h(s.kind)+'</span> '+
      (s.primary?'<span class="tag blue">主存储</span> ':'')+
      '<span class="tag '+(s.available?'ok':'bad')+'">'+(s.available?'可用':'不可用')+'</span> '+
      '<span class="tag '+(s.enabled?'ok':'off')+'">'+(s.enabled?'已启用':'已停用')+'</span>'+
      '<br><span class="small dim">优先级 '+s.priority+' · 已用 '+bytes(s.usedBytes)+' / '+bytes(s.maxBytes)+' · '+s.files+' 个文件'+
      (s.endpoint?' · '+h(s.endpoint):'')+(s.bucket?' / '+h(s.bucket):'')+'</span>'+
      (s.reason?'<br><span class="small" style="color:#b45309">'+h(s.reason)+'</span>':'')+'</div>'+
      '<div class="line" style="border:0;padding:0">'+sw(s.enabled,'data-en="'+h(s.id)+'"')+'</div>'+
      '<button class="btn sm pri" data-detail="'+h(s.id)+'">详情</button>'+
      '<button class="btn sm" data-test="'+h(s.id)+'">测试</button>'+
      '<button class="btn sm" data-scan="'+h(s.id)+'">扫描</button>'+
      '<button class="btn sm" data-edit="'+h(s.id)+'">编辑</button>'+
      (s.kind==='s3'?'<button class="btn sm bad" data-del="'+h(s.id)+'">删除</button>':'')+'</div>'+
     '<div class="bar" style="margin-top:10px"><i class="'+(pct>=90?'bad':pct>=70?'warn':'')+'" style="width:'+pct+'%"></i></div></div>'}).join('')
   :'<div class="empty">没有任何存储</div>')+'</div>'+
   '<div class="card"><h3>'+(editing?('编辑存储 · '+h(editing.name)):'添加 S3 兼容存储')+'</h3>'+
   '<div class="sub">'+(editing?'内置存储(KV / R2)只能改启用、优先级和容量上限;S3 可以改全部字段':'适合放大量文件的外部存储:Filebase、Upstash、MinIO、Cloudflare R2 的 S3 接口等')+'</div>'+
   '<div class="row"><div><label class="f">名称</label><input class="t" id="sr-name" value="'+(editing?h(editing.name):'')+'"></div>'+
   '<div><label class="f">优先级(数字越大越优先)</label><input class="t" type="number" id="sr-prio" value="'+(editing?editing.priority:50)+'"></div></div>'+
   (editing&&editing.kind!=='s3'?'':(
    '<div class="fld" style="margin-top:13px"><label class="f">Endpoint</label><input class="t mono" id="sr-ep" value="'+(editing?h(editing.endpoint||''):'')+'" placeholder="https://s3.us-east-1.amazonaws.com"></div>'+
    '<div class="row"><div><label class="f">Bucket</label><input class="t mono" id="sr-bk" value="'+(editing?h(editing.bucket||''):'')+'"></div>'+
    '<div><label class="f">Region(可填 auto)</label><input class="t mono" id="sr-rg" value="'+(editing?h(editing.region||''):'')+'" placeholder="auto"></div></div>'+
    '<div class="row" style="margin-top:13px"><div><label class="f">Access Key</label><input class="t mono" id="sr-ak" value="'+(editing?h(editing.accessKey||''):'')+'"></div>'+
    '<div><label class="f">Secret Key'+(editing?'(留空 = 不改)':'')+'</label><input class="t mono" type="password" id="sr-sk" value=""></div></div>'+
    '<div class="fld" style="margin-top:13px"><label style="font-size:13px"><input type="checkbox" id="sr-ps"'+(editing?(editing.pathStyle!==false?' checked':''):' checked')+'> Path-Style 寻址(大多数 S3 兼容服务需要;AWS 原生可以关)</label></div>'))+
   '<div class="fld"><label class="f">容量上限(GB)</label><input class="t" type="number" id="sr-max" value="'+(editing?Math.max(1,Math.round((editing.maxBytes||0)/1073741824)):5)+'"></div>'+
   '<button class="btn pri" id="sr-save">'+(editing?'保存修改':'添加存储')+'</button> '+(editing?'<button class="btn" id="sr-cancel">取消编辑</button>':'')+'</div>'+
   '<div class="card" style="border-color:#fecaca"><h3 style="color:#b91c1c">危险操作</h3><div class="sub">重置会清空 D1 里的配置、项目、日志、统计、群组、技能、扩展、模块,清空 KV/R2 文件,并清空机器人的会话上下文。S3 物理文件需要到服务商后台删除。操作不可恢复。</div>'+
   '<button class="btn bad" id="reset-all">重置全部数据</button></div>';
  var byId=function(id){return stores.filter(function(x){return x.id===id})[0]||{}};
  v.querySelectorAll('[data-en]').forEach(function(n){n.onclick=function(){
   var s=byId(n.dataset.en);
   var store={id:s.id,kind:s.kind,name:s.name,priority:s.priority,maxBytes:s.maxBytes,enabled:!n.classList.contains('on')};
   if(s.kind==='s3'){store.endpoint=s.endpoint;store.bucket=s.bucket;store.region=s.region;store.accessKey=s.accessKey;store.pathStyle=s.pathStyle}
   api('/storage/save',{method:'POST',body:{store:store}}).then(function(){render()}).catch(function(e){toast(e.message)})}});
  v.querySelectorAll('[data-test]').forEach(function(b){b.onclick=function(){
   var old=b.textContent;b.disabled=true;b.textContent='测试中…';
   api('/storage/test',{method:'POST',body:{id:b.dataset.test}}).then(function(r){
    toast(r.ok?(r.note||'可用'):('不可用:'+(r.error||'')))})
    .catch(function(e){toast(e.message)}).then(function(){b.disabled=false;b.textContent=old})}});
  v.querySelectorAll('[data-scan]').forEach(function(b){b.onclick=function(){
   var old=b.textContent;b.disabled=true;b.textContent='扫描中…';
   api('/storage/scan',{method:'POST',body:{id:b.dataset.scan}}).then(function(r){
    toast('扫描完成:'+bytes(r.bytes)+' / '+r.files+' 个文件');render()})
    .catch(function(e){toast(e.message)}).then(function(){b.disabled=false;b.textContent=old})}});
  v.querySelectorAll('[data-edit]').forEach(function(b){b.onclick=function(){storeEdit=byId(b.dataset.edit);render()}});
  v.querySelectorAll('[data-detail]').forEach(function(b){b.onclick=function(){go('storage/'+b.dataset.detail)}});
  v.querySelectorAll('[data-del]').forEach(function(b){b.onclick=function(){
   var s=byId(b.dataset.del);
   confirmBox('删除存储','确认移除「'+h(s.name||b.dataset.del)+'」?存储里已有的文件不会自动删除。',function(){
    api('/storage/remove',{method:'POST',body:{id:b.dataset.del}}).then(function(){
     toast('已移除');if(storeEdit&&storeEdit.id===b.dataset.del)storeEdit=null;render()})},true)}});
  v.querySelector('[data-cache]').onclick=function(){var on=!this.classList.contains('on');
   api('/storage/cache',{method:'POST',body:{enabled:on}}).then(function(){toast('已'+(on?'开启':'关闭'));render()})};
  v.querySelector('#sr-save').onclick=function(){var b=this;
   var store={id:editing?editing.id:'',kind:editing?editing.kind:'s3',name:v.querySelector('#sr-name').value.trim(),
    priority:Number(v.querySelector('#sr-prio').value)||(editing?editing.priority:50),
    maxBytes:Math.max(1,Number(v.querySelector('#sr-max').value)||5)*1073741824,
    enabled:editing?editing.enabled:true};
   if(!editing||editing.kind==='s3'){
    store.endpoint=v.querySelector('#sr-ep').value.trim();
    store.bucket=v.querySelector('#sr-bk').value.trim();
    store.region=v.querySelector('#sr-rg').value.trim()||'auto';
    store.accessKey=v.querySelector('#sr-ak').value.trim();
    store.secretKey=v.querySelector('#sr-sk').value.trim();
    store.pathStyle=v.querySelector('#sr-ps').checked;
   }
   b.disabled=true;
   api('/storage/save',{method:'POST',body:{store:store}})
    .then(function(){toast('已保存');storeEdit=null;render()})
    .catch(function(e){toast(e.message)}).then(function(){b.disabled=false})};
  if(editing)v.querySelector('#sr-cancel').onclick=function(){storeEdit=null;render()};
  v.querySelector('#reset-all').onclick=function(){
   confirmBox('重置全部数据','这会删除 D1 配置/项目/日志、KV/R2 文件、机器人会话上下文,且不可恢复。确定继续?',function(){
    var m=modal('确认管理员身份','<div class="hint" style="border-color:#fecaca;color:#b91c1c">最后一步:输入管理员用户名和密码。验证通过后会立即重置并短暂重载面板。</div>'+
     '<div class="fld"><label class="f">管理员用户名</label><input class="t" id="rs-user" autocomplete="username"></div>'+
     '<div class="fld"><label class="f">管理员密码</label><input class="t" type="password" id="rs-pass" autocomplete="current-password"></div>',
     '<button class="btn" data-x>取消</button><button class="btn bad" data-ok>确认重置</button>');
    m.querySelector('[data-x]').onclick=function(){m.remove()};
    m.querySelector('[data-ok]').onclick=function(){var b=this;b.disabled=true;b.textContent='重置中…';
     api('/reset',{method:'POST',body:{user:m.querySelector('#rs-user').value.trim(),pass:m.querySelector('#rs-pass').value}})
      .then(function(r){m.remove();toast(r.note||'已重置,面板即将重载');setTimeout(function(){location.reload()},1800)})
      .catch(function(e){toast(e.message);b.disabled=false;b.textContent='确认重置'})};
   },true)};
}).catch(function(e){v.innerHTML='<div class="card"><div class="empty">'+h(e.message)+'</div></div>'});
}

(function boot(){
 var r=(location.hash||'').replace(/^#\\/?/,'');
 S.route=r||'home';
 render();
 if(ME.warnings&&ME.warnings.length)setTimeout(function(){
  var m=modal('配置提醒','<div class="hint" style="border-color:#fecaca;color:#b91c1c;line-height:1.9">'+
   ME.warnings.map(function(w){return '· '+h(w)}).join('<br>')+
   '<br><br>可以先进入面板查看;依赖缺失配置的功能会返回明确提示。配置好后刷新本页即可。</div>',
   '<button class="btn pri" data-x>知道了</button>');
  m.querySelector('[data-x]').onclick=function(){m.remove()};
 },400);
 if(ME.checkUpdates)setTimeout(function(){
  api('/update/check').then(function(r){if(r&&(r.updateAvailable||r.force))showUpdateInfo(r)}).catch(function(){});
 },2500);
})();
</script>
</body>
</html>`;
}
