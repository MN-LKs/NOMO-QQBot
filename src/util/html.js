// 极简 HTML 处理:够用就行,不引第三方解析器(省 CPU、省体积)。

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–',
  laquo: '«', raquo: '»', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
};

export function decodeEntities(s) {
  return String(s ?? '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(Math.min(code, 0x10ffff)) : m;
    }
    return ENTITIES[body] ?? m;
  });
}

/** 把 HTML 变成可读纯文本 */
export function htmlToText(html, maxChars = 6000) {
  let s = String(html ?? '');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style|noscript|svg|head|iframe)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  s = s.replace(/<\/(p|div|li|h[1-6]|tr|br|section|article)\s*>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  s = s.replace(/[ \t\u00a0]+/g, ' ');
  s = s.replace(/\n[ \t]+/g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  s = s.trim();
  if (s.length > maxChars) s = s.slice(0, maxChars) + '\n…(已截断)';
  return s;
}

/** 抽 <title> */
export function htmlTitle(html) {
  const m = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(String(html ?? ''));
  return m ? decodeEntities(m[1]).trim() : '';
}

/**
 * 从搜索结果页里抠出 {title,url,snippet} 列表。
 * 兼容 Bing / DuckDuckGo(html,lite) / 搜狗 三种常见结构。
 */
export function parseSearchResults(html, limit = 6) {
  const out = [];
  const seen = new Set();
  const push = (url, title, snippet) => {
    if (!url || !/^https?:/i.test(url)) return;
    const key = url.replace(/#.*$/, '');
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ title: clean(title), url, snippet: clean(snippet) });
  };

  // --- Bing ---
  if (html.includes('b_algo')) {
    for (const block of html.split('<li class="b_algo"').slice(1)) {
      const h2 = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
      const p = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block);
      if (h2) push(decodeEntities(h2[1]), h2[2], p ? p[1] : '');
      if (out.length >= limit) break;
    }
    if (out.length) return out;
  }

  // --- DuckDuckGo html ---
  if (html.includes('result__a')) {
    const re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    const reSn = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
    const titles = [];
    let m;
    while ((m = re.exec(html)) && titles.length < limit) titles.push([m[1], m[2]]);
    const snips = [];
    while ((m = reSn.exec(html)) && snips.length < limit) snips.push(m[1]);
    titles.forEach(([u, t], i) => push(unescapeDdg(u), t, snips[i] || ''));
    if (out.length) return out;
  }

  // --- DuckDuckGo lite ---
  if (html.includes('result-link') || html.includes('result-snippet')) {
    const re = /<a[^>]*class="[^"]*result-link[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    const reSn = /class="[^"]*result-snippet[^"]*"[^>]*>([\s\S]*?)<\/td>/gi;
    const titles = [];
    let m;
    while ((m = re.exec(html)) && titles.length < limit) titles.push([m[1], m[2]]);
    const snips = [];
    while ((m = reSn.exec(html)) && snips.length < limit) snips.push(m[1]);
    titles.forEach(([u, t], i) => push(unescapeDdg(u), t, snips[i] || ''));
    if (out.length) return out;
  }

  // --- 搜狗 ---
  if (html.includes('vrwrap') || html.includes('<h3')) {
    for (const block of html.split(/<div[^>]*class="[^"]*(?:vrwrap|rb)[^"]*"/i).slice(1)) {
      const a = /<h3[^>]*>[\s\S]{0,200}?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
      if (!a) continue;
      const sn = /<div[^>]*class="[^"]*(?:text-layout|str_info|fz-mid)[^"]*"[^>]*>([\s\S]{0,600}?)<\/div>/i.exec(block);
      push(a[1].startsWith('/link') ? `https://www.sogou.com${a[1]}` : a[1], a[2], sn ? sn[1] : '');
      if (out.length >= limit) break;
    }
    if (out.length) return out;
  }

  // --- 兜底:抓所有外链 ---
  const re = /<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]{1,200}?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < limit) push(m[1], m[2], '');
  return out;

  function clean(x) {
    return htmlToText(x, 400).replace(/\s+/g, ' ').trim();
  }
}

function unescapeDdg(u) {
  const m = /[?&]uddg=([^&]+)/.exec(u);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return u;
    }
  }
  return u.startsWith('//') ? `https:${u}` : u;
}
