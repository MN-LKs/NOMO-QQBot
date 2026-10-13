import { calc, formatNumber } from '../util/calc.js';
import { htmlToText } from '../util/html.js';
import { truncate } from '../util/text.js';
import { webSearch } from './search.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

const TOOL_LIST = 'calc, now, web_search, fetch_url, deploy_site, update_site, list_sites, read_site, delete_site';

function fmtTime(d, offsetHours) {
  const t = new Date(d.getTime() + offsetHours * 3600_000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const week = ['日', '一', '二', '三', '四', '五', '六'][t.getUTCDay()];
  return {
    text: `${t.getUTCFullYear()}年${p(t.getUTCMonth() + 1)}月${p(t.getUTCDate())}日 星期${week} `
      + `${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}`,
    iso: `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}T`
      + `${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}`,
    tz: offsetHours >= 0 ? `UTC+${offsetHours}` : `UTC${offsetHours}`,
  };
}

function assertPublicUrl(raw) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    throw new Error('网址格式不对');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('只支持 http/https');
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')
    || host.endsWith('.internal') || host === 'metadata.google.internal') {
    throw new Error('不允许访问内网地址');
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b] = host.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)
      || (a === 169 && b === 254) || a >= 224) {
      throw new Error('不允许访问内网地址');
    }
  }
  if (host === '[::1]' || host.startsWith('fd') || host.startsWith('fe80')) {
    throw new Error('不允许访问内网地址');
  }
  return u;
}

async function fetchText(url, { timeoutMs = 20000, maxBytes = 800000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/json;q=0.9,*/*;q=0.8' },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    if (buf.byteLength > maxBytes) throw new Error(`页面太大(${buf.byteLength} 字节),已放弃`);
    return new TextDecoder('utf-8', { fatal: false }).decode(buf);
  } finally {
    clearTimeout(timer);
  }
}

export async function executeTool(name, args, ctx) {
  const a = args && typeof args === 'object' ? args : {};
  try {
    switch (name) {
      case 'calc': {
        const v = calc(a.expression);
        return `${a.expression} = ${formatNumber(v)}`;
      }

      case 'now': {
        const off = Number.isFinite(Number(a.offset_hours)) ? Number(a.offset_hours) : 8;
        const t = fmtTime(new Date(), off);
        return `现在是 ${t.text}(${t.tz}),ISO: ${t.iso}`;
      }

      case 'web_search':
        return await webSearch(ctx.cfg, String(a.query || ''), a.count);

      case 'fetch_url': {
        const u = assertPublicUrl(a.url);
        const maxChars = Math.max(500, Math.min(12000, Number(a.max_chars) || 4000));
        const raw = await fetchText(u.toString());
        const head = raw.trimStart();
        const text = head.startsWith('{') || head.startsWith('[')
          ? truncate(raw, maxChars)
          : htmlToText(raw, maxChars);
        return `来自 ${u.toString()} 的正文:\n${text}`;
      }

      case 'deploy_site': {
        const files = normaliseFiles(a.files, ctx.cfg);
        const r = await ctx.core.createSite({
          name: a.name,
          description: a.description,
          files,
          owner: ctx.convId,
        });
        if (r.error) return r.error;
        return [
          '部署成功 ✅',
          `项目名: ${r.site.name}`,
          `链接: ${r.site.url}`,
          `ID: ${r.site.id}`,
          `文件: ${r.site.files.map((f) => f.path).join(', ')}`,
          `存活: 从现在起 ${Math.round(ctx.cfg.siteTtlSeconds / 60)} 分钟,期间任何修改都会重新计时`,
          `当前在线部署: ${r.count}/${ctx.cfg.maxSites}`,
          r.evicted ? `⚠️ 已自动清理最久未改动的部署 ${r.evicted.id}(${r.evicted.name})以腾出名额` : '',
          '【重要】请把上面这个链接原样发在回复里,并简单说明怎么玩。',
        ].filter(Boolean).join('\n');
      }

      case 'update_site': {
        const files = normaliseFiles(a.files, ctx.cfg);
        const r = await ctx.core.updateSite(String(a.id || ''), { name: a.name, files });
        if (r.error) return r.error;
        return [
          `修改成功 ✅ 链接不变: ${r.site.url}`,
          `文件: ${r.site.files.map((f) => f.path).join(', ')}`,
          `倒计时已重置为 ${Math.round(ctx.cfg.siteTtlSeconds / 60)} 分钟`,
          '【重要】请把链接原样告诉用户。',
        ].join('\n');
      }

      case 'list_sites': {
        const list = await ctx.core.listSites();
        if (!list.length) return '当前没有任何在线部署。';
        const now = Date.now();
        return [
          `当前在线部署 ${list.length}/${ctx.cfg.maxSites} 个:`,
          ...list.map((s, i) => {
            const left = Math.max(0, Math.round((s.expiresAt - now) / 1000));
            return `${i + 1}. ${s.name} | ID=${s.id} | ${s.url} | 剩余 ${left} 秒 | 文件 ${s.files.map((f) => f.path).join(',')}`;
          }),
        ].join('\n');
      }

      case 'read_site': {
        const r = await ctx.core.getSite(String(a.id || ''));
        if (!r) return `没找到 ID 为 ${a.id} 的部署,先用 list_sites 看看有哪些。`;
        if (a.path) {
          const f = r.files.find((x) => x.path === a.path);
          if (!f) return `该部署里没有 ${a.path},现有文件:${r.files.map((x) => x.path).join(', ')}`;
          return `${a.path} 的内容:\n${truncate(f.content, 12000)}`;
        }
        return [
          `${r.name}(${r.id}) ${r.url}`,
          '文件清单:',
          ...r.files.map((f) => `--- ${f.path} (${f.content.length} 字) ---\n${truncate(f.content, 800)}`),
        ].join('\n');
      }

      case 'delete_site': {
        const ok = await ctx.core.deleteSite(String(a.id || ''));
        return ok ? `已删除部署 ${a.id},链接已失效。` : `没找到 ID 为 ${a.id} 的部署。`;
      }

      default:
        return `没有名为 ${name} 的工具。可用工具:${TOOL_LIST}。`;
    }
  } catch (e) {
    return `工具 ${name} 执行失败: ${e?.message || e}`;
  }
}

export function normaliseFiles(files, cfg) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('files 不能为空,至少要有一个 index.html');
  }
  if (files.length > 12) throw new Error('一个站点最多 12 个文件');
  const out = [];
  let total = 0;
  for (const f of files) {
    const path = String(f?.path ?? '').trim().replace(/^\.\//, '');
    if (!path) throw new Error('文件路径不能为空');
    if (path.startsWith('/') || path.includes('..') || path.includes('\\')) {
      throw new Error(`非法路径 ${path}`);
    }
    if (!/^[\w.\-\u4e00-\u9fa5]+(\/[\w.\-\u4e00-\u9fa5]+)*$/.test(path)) {
      throw new Error(`路径 ${path} 含非法字符`);
    }
    const content = String(f?.content ?? '');
    total += content.length;
    if (total > cfg.maxSiteBytes) {
      throw new Error(`代码总量超过上限 ${cfg.maxSiteBytes} 字节,请精简后再部署`);
    }
    const existing = out.find((x) => x.path === path);
    if (existing) existing.content = content;
    else out.push({ path, content });
  }
  if (!out.some((f) => f.path.toLowerCase() === 'index.html')) {
    throw new Error('必须包含 index.html 作为入口页');
  }
  return out;
}
