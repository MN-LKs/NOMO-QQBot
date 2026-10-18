function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function confirmPage({ token, pending, result, error }) {
  const p = pending?.payload || {};
  const files = Array.isArray(p.files) ? p.files : [];
  const site = result?.site;
  let body = '';
  if (error) {
    body = `<div class="err">${esc(error)}</div>`;
  } else if (result?.canceled) {
    body = '<div class="ok">已取消这次部署,不会创建任何项目。</div>';
  } else if (site) {
    body = `<div class="ok">部署成功 ✅</div>
      <p><b>${esc(site.name || '未命名项目')}</b></p>
      <p><a class="link" href="${esc(site.url)}" target="_blank" rel="noopener">${esc(site.url)}</a></p>
      <p class="dim">存活 ${esc(site.ttlMinutes)} 分钟,到期自动销毁。</p>`;
  } else if (!pending) {
    body = '<div class="err">这个确认链接已过期,或者已经处理过了。</div>';
  } else {
    const left = Math.max(0, Math.round((Number(pending.expires_at) - Date.now()) / 60000));
    body = `<p class="dim">机器人想部署下面这个项目,确认后才会真正创建。链接 ${left} 分钟内有效。</p>
      <h2>${esc(p.name || '未命名项目')}</h2>
      ${p.description ? `<p>${esc(p.description)}</p>` : ''}
      <div class="files">${files.map((f) => `<div><code>${esc(f.path)}</code><span>${esc((f.content || '').length)} 字符</span></div>`).join('')}</div>
      <form method="post" action="/confirm/${esc(token)}">
        <button class="btn ok" name="action" value="approve">确认部署</button>
        <button class="btn bad" name="action" value="cancel">取消</button>
      </form>`;
  }
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>确认部署 · NOMO</title>
<style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
 font:15px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
 background:radial-gradient(900px 600px at 10% 0%,#dbeafe,transparent 55%),linear-gradient(135deg,#f8fafc,#eef2ff 60%,#fdf2f8);
 color:#0f172a;padding:20px}
.card{width:min(560px,100%);background:rgba(255,255,255,.78);border:1px solid rgba(255,255,255,.9);border-radius:24px;
 box-shadow:0 24px 70px rgba(15,23,42,.16);backdrop-filter:blur(24px);padding:28px}
h1{font-size:18px;margin:0 0 4px}h2{font-size:16px;margin:18px 0 6px}.dim{color:#64748b;font-size:13px}
.err{padding:12px 14px;border-radius:12px;background:#fef2f2;color:#b91c1c;border:1px solid #fecaca}
.ok{padding:12px 14px;border-radius:12px;background:#ecfdf5;color:#047857;border:1px solid #a7f3d0;margin-bottom:10px}
.files{margin:14px 0;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden}
.files div{display:flex;justify-content:space-between;gap:10px;padding:9px 12px;border-bottom:1px solid #eef2f7;font-size:13px}
.files div:last-child{border-bottom:0}code{font-family:ui-monospace,Menlo,Consolas,monospace;word-break:break-all}
.link{color:#4f46e5;word-break:break-all}form{display:flex;gap:10px;margin-top:18px}
.btn{border:1px solid #e2e8f0;background:#fff;border-radius:12px;padding:10px 18px;font:inherit;cursor:pointer}
.btn.ok{background:linear-gradient(135deg,#10b981,#059669);border-color:transparent;color:#fff}
.btn.bad{background:#fff;border-color:#fecaca;color:#b91c1c}
</style></head><body><div class="card"><h1>部署确认</h1>${body}</div></body></html>`;
}
