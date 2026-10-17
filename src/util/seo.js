// 部署页面的 SEO / 质量分兜底。
// 系统提示词要求 AI 把技术标签写全;没写、写空或只写了一半的,这里用默认值补齐。
// 已经写好且非空的字段一律不覆盖。
//
// 覆盖范围:
//   charset / title / description / viewport / robots / author / theme-color / color-scheme
//   canonical / favicon / Open Graph / Twitter Card / JSON-LD(WebPage + WebSite)
// 另外会把裸片段包成完整 HTML 文档,保证扫描器能拿到 head 和 lang。

const HTML_OPEN = /<html(?:\s[^>]*)?>/i;
const HEAD_OPEN = /<head(?:\s[^>]*)?>/i;
const HEAD_CLOSE = /<\/head\s*>/i;
const BODY_OPEN = /<body(?:\s[^>]*)?>/i;
const DOCTYPE = /<!doctype\s+html[^>]*>/i;
const HAS_CHARSET = /<meta[^>]*\bcharset\s*=/i;
const HAS_JSONLD = /application\/ld\+json/i;
const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;
const CANONICAL_RE = /<link\b[^>]*\brel\s*=\s*["']?canonical["']?[^>]*>/i;
const ICON_RE = /<link\b[^>]*\brel\s*=\s*["']?(?:shortcut\s+)?(?:apple-touch-)?icon["']?[^>]*>/i;

const FAVICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%232563eb'/%3E%3Ctext x='32' y='44' font-size='36' font-family='sans-serif' font-weight='700' fill='white' text-anchor='middle'%3EN%3C/text%3E%3C/svg%3E";

function attr(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function plainText(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function jsonLd(obj) {
  // 转义 < ,防止页面名里出现 </script> 把脚本提前截断
  return JSON.stringify(obj).replace(/</g, '\\u003c');
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function metaPattern(attrName, key) {
  return new RegExp(`<meta\\b[^>]*\\b${attrName}\\s*=\\s*["']?${escapeRe(key)}["']?[^>]*>`, 'i');
}

function attrValue(tag, name) {
  const m = String(tag).match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  if (!m) return '';
  return String(m[2] ?? m[3] ?? m[4] ?? '').trim();
}

// 缺失就补;存在但 content 为空也补;已有非空内容则原样保留
function ensureMeta(html, attrName, key, content, blocks) {
  const re = metaPattern(attrName, key);
  const tag = html.match(re);
  if (tag) {
    if (attrValue(tag[0], 'content')) return html;
    return html.replace(re, `<meta ${attrName}="${attr(key)}" content="${attr(content)}">`);
  }
  blocks.push(`<meta ${attrName}="${attr(key)}" content="${attr(content)}">`);
  return html;
}

function ensureTitle(html, value, blocks) {
  const tag = html.match(TITLE_RE);
  if (tag) {
    if (plainText(tag[1])) return html;
    return html.replace(TITLE_RE, `<title>${attr(value)}</title>`);
  }
  blocks.push(`<title>${attr(value)}</title>`);
  return html;
}

function ensureCanonical(html, url, blocks) {
  if (!url) return html;
  const tag = html.match(CANONICAL_RE);
  if (tag) {
    if (attrValue(tag[0], 'href')) return html;
    return html.replace(CANONICAL_RE, `<link rel="canonical" href="${attr(url)}">`);
  }
  blocks.push(`<link rel="canonical" href="${attr(url)}">`);
  return html;
}

// 裸片段(AI 只返回 <div>…</div>)也包成完整文档,否则扫描器拿不到 head
function ensureDocument(html) {
  if (HTML_OPEN.test(html) || HEAD_OPEN.test(html) || BODY_OPEN.test(html)) return html;
  const body = html.replace(DOCTYPE, '').trim();
  return `<!DOCTYPE html><html lang="zh-CN"><head></head><body>${body}</body></html>`;
}

function ensureDoctype(html) {
  if (DOCTYPE.test(html)) return html;
  if (HTML_OPEN.test(html) || HEAD_OPEN.test(html)) return `<!DOCTYPE html>${html}`;
  return html;
}

function ensureHead(html) {
  if (HEAD_OPEN.test(html)) return html;
  if (HTML_OPEN.test(html)) return html.replace(HTML_OPEN, (m) => `${m}<head></head>`);
  if (BODY_OPEN.test(html)) return html.replace(BODY_OPEN, (m) => `<head></head>${m}`);
  return html;
}

function ensureLang(html) {
  if (!HTML_OPEN.test(html)) return html;
  if (/<html[^>]*\blang\s*=/i.test(html)) return html;
  return html.replace(HTML_OPEN, (m) => `${m.slice(0, -1)} lang="zh-CN">`);
}

export function seoEnhance(raw, { name = '', description = '', url = '' } = {}) {
  let html = String(raw === null || raw === undefined ? '' : raw);
  if (!html.trim()) return html;

  html = ensureDocument(html);
  html = ensureDoctype(html);
  html = ensureHead(html);
  html = ensureLang(html);

  const titleTag = html.match(TITLE_RE);
  const titleText = titleTag ? plainText(titleTag[1]) : '';
  const cleanName = String(name || '').trim();
  const cleanDesc = String(description || '').trim();
  const fallbackTitle = cleanName || titleText || '网页';
  const title = titleText || fallbackTitle;
  const desc = (cleanDesc
    || (cleanName ? `${cleanName} —— 由 NOMO-QQBot 部署的网页` : '由 NOMO-QQBot 部署的网页,链接到期自动销毁'))
    .replace(/\s+/g, ' ')
    .slice(0, 160);

  const pageUrl = /^https?:\/\//i.test(String(url || '')) ? String(url) : '';
  let siteUrl = '';
  if (pageUrl) {
    try {
      siteUrl = `${new URL(pageUrl).origin}/`;
    } catch {
      siteUrl = '';
    }
  }
  const siteName = cleanName || title || 'NOMO-QQBot 部署页面';

  const blocks = [];
  html = ensureTitle(html, title, blocks);
  html = ensureMeta(html, 'name', 'description', desc, blocks);
  html = ensureMeta(html, 'name', 'viewport', 'width=device-width,initial-scale=1', blocks);
  html = ensureMeta(html, 'name', 'robots', 'index,follow', blocks);
  html = ensureMeta(html, 'name', 'author', 'NOMO-QQBot', blocks);
  html = ensureMeta(html, 'name', 'theme-color', '#2563eb', blocks);
  html = ensureMeta(html, 'name', 'color-scheme', 'light dark', blocks);
  html = ensureCanonical(html, pageUrl, blocks);

  html = ensureMeta(html, 'property', 'og:type', 'website', blocks);
  html = ensureMeta(html, 'property', 'og:title', title, blocks);
  html = ensureMeta(html, 'property', 'og:description', desc, blocks);
  if (pageUrl) html = ensureMeta(html, 'property', 'og:url', pageUrl, blocks);
  html = ensureMeta(html, 'property', 'og:site_name', siteName, blocks);
  html = ensureMeta(html, 'property', 'og:locale', 'zh_CN', blocks);

  html = ensureMeta(html, 'name', 'twitter:card', 'summary', blocks);
  html = ensureMeta(html, 'name', 'twitter:title', title, blocks);
  html = ensureMeta(html, 'name', 'twitter:description', desc, blocks);

  if (!ICON_RE.test(html)) blocks.push(`<link rel="icon" href="${FAVICON}">`);

  if (!HAS_JSONLD.test(html)) {
    const graph = [{
      '@type': 'WebPage',
      ...(pageUrl ? { '@id': `${pageUrl}#webpage`, url: pageUrl } : {}),
      name: title,
      description: desc,
      inLanguage: 'zh-CN',
      ...(siteUrl ? { isPartOf: { '@id': `${siteUrl}#website` } } : {}),
    }];
    if (siteUrl) {
      graph.push({
        '@type': 'WebSite',
        '@id': `${siteUrl}#website`,
        name: siteName,
        url: siteUrl,
        inLanguage: 'zh-CN',
      });
    }
    blocks.push(`<script type="application/ld+json">${jsonLd({ '@context': 'https://schema.org', '@graph': graph })}</script>`);
  }

  // charset 放在 head 最前面,避免浏览器猜编码
  if (!HAS_CHARSET.test(html)) {
    html = html.replace(HEAD_OPEN, (m) => `${m}<meta charset="utf-8">`);
  }

  if (blocks.length) {
    const chunk = blocks.join('');
    if (HEAD_CLOSE.test(html)) html = html.replace(HEAD_CLOSE, `${chunk}</head>`);
    else if (HEAD_OPEN.test(html)) html = html.replace(HEAD_OPEN, (m) => m + chunk);
  }
  return html;
}

export function enhanceFiles(files, meta = {}) {
  if (!Array.isArray(files)) return files;
  return files.map((f) => {
    if (!f || typeof f !== 'object') return f;
    if (!/\.html?$/i.test(String(f.path || ''))) return f;
    return { ...f, content: seoEnhance(f.content, meta) };
  });
}
