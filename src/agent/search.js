// 联网搜索:一个「带 /v1 的 url」+ key,自动拼出 /search 与 /reader 两个端点。
// - web_search 走 /search(关键词搜索)
// - fetch_url  走 /reader(网页正文读取,能处理 JS 动态渲染的站点)
// 返回结构可以自定义映射(比如结果在 data.items,标题字段叫 name),适配各种中转站。
import { truncate } from '../util/text.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const TIMEOUT_MS = 15000;

const URL_KEYS = ['url', 'link', 'href', 'uri', 'source_url', 'sourceUrl', 'page_url', 'pageUrl'];
const TITLE_KEYS = ['title', 'name', 'heading', 'headline'];
const SNIPPET_KEYS = ['snippet', 'description', 'summary', 'content', 'text', 'abstract', 'desc'];
const CONTENT_KEYS = ['content', 'text', 'markdown', 'md', 'body', 'article', 'result', 'data', 'answer', 'summary'];

export const SUPPORTED_PROVIDERS = [
  'metaso', 'exa', 'tavily', 'serper', 'brave', 'bing', 'google', 'serpapi', 'generic',
];

export function detectProvider(rawUrl) {
  let host = '';
  try {
    host = new URL(String(rawUrl)).hostname.toLowerCase();
  } catch {
    return 'generic';
  }
  if (host.includes('metaso')) return 'metaso';
  if (host.includes('exa.ai')) return 'exa';
  if (host.includes('tavily')) return 'tavily';
  if (host.includes('serper')) return 'serper';
  if (host.includes('brave')) return 'brave';
  if (host.includes('bing')) return 'bing';
  if (host.includes('googleapis')) return 'google';
  if (host.includes('serpapi')) return 'serpapi';
  return 'generic';
}

// ---------------------------------------------------------------------------
// 返回结构映射:支持 'data.items'、'result.list'、'data.0.items' 这类点路径
// ---------------------------------------------------------------------------

export function getPath(obj, path) {
  if (!path) return undefined;
  let cur = obj;
  for (const seg of String(path).split('.').filter(Boolean)) {
    if (cur === undefined || cur === null) return undefined;
    if (Array.isArray(cur)) {
      const i = Number(seg);
      if (!Number.isInteger(i) || i < 0 || i >= cur.length) return undefined;
      cur = cur[i];
    } else if (typeof cur === 'object') {
      cur = cur[seg];
    } else {
      return undefined;
    }
  }
  return cur;
}

function pickTextByPath(o, path, fallbackKeys) {
  if (path) {
    const v = getPath(o, path);
    if (typeof v === 'string' && v.trim()) return v;
  }
  return firstText(o, fallbackKeys);
}

function firstText(o, keys) {
  for (const k of keys) {
    const v = o?.[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return '';
}

function urlOf(o) {
  for (const k of URL_KEYS) {
    const v = o?.[k];
    if (typeof v === 'string' && /^https?:\/\//i.test(v)) return v;
  }
  return '';
}

function pickList(json) {
  const found = [];
  const walk = (v, depth) => {
    if (!v || depth > 5 || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      const objs = v.filter((x) => x && typeof x === 'object' && !Array.isArray(x));
      if (objs.length && objs.some(urlOf)) found.push(objs);
      for (const x of v) walk(x, depth + 1);
      return;
    }
    for (const k of Object.keys(v)) walk(v[k], depth + 1);
  };
  walk(json, 0);
  if (!found.length) return [];
  found.sort((a, b) => b.length - a.length);
  return found[0];
}

export function extractResults(provider, json, limit = 5, map = {}) {
  let list = null;
  if (map && map.results) {
    const v = getPath(json, map.results);
    if (Array.isArray(v)) list = v;
  }
  if (!Array.isArray(list)) {
    switch (provider) {
      case 'metaso': list = json?.webpages; break;
      case 'exa': list = json?.results; break;
      case 'tavily': list = json?.results; break;
      case 'serper': list = json?.organic; break;
      case 'brave': list = json?.web?.results; break;
      case 'bing': list = json?.webPages?.value; break;
      case 'google': list = json?.items; break;
      case 'serpapi': list = json?.organic_results; break;
      default: list = null; break;
    }
  }
  if (!Array.isArray(list) || !list.some(urlOf)) list = pickList(json);

  const out = [];
  const seen = new Set();
  for (const item of list || []) {
    const url = urlOf(item) || (map?.url ? String(getPath(item, map.url) || '') : '');
    if (!url || !/^https?:\/\//i.test(url)) continue;
    const key = url.replace(/#.*$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      title: pickTextByPath(item, map?.title, TITLE_KEYS).replace(/\s+/g, ' ').trim(),
      url,
      snippet: pickTextByPath(item, map?.snippet, SNIPPET_KEYS).replace(/\s+/g, ' ').trim(),
    });
    if (out.length >= limit) break;
  }
  return out;
}

// 从任意 JSON 里挖出「正文」:优先按映射路径,其次按常见字段名递归找最长的字符串
export function pickContent(json, mapPath = '') {
  if (typeof json === 'string') return json.trim();
  if (mapPath) {
    const v = getPath(json, mapPath);
    if (typeof v === 'string' && v.trim()) return v;
  }
  if (Array.isArray(json)) {
    for (const x of json) {
      const t = pickContent(x, '');
      if (t) return t;
    }
    return '';
  }
  if (json && typeof json === 'object') {
    for (const k of CONTENT_KEYS) {
      const v = json[k];
      if (typeof v === 'string' && v.trim().length > 40) return v;
    }
    let best = '';
    for (const v of Object.values(json)) {
      if (v && typeof v === 'object') {
        const t = pickContent(v, '');
        if (t.length > best.length) best = t;
      } else if (typeof v === 'string' && v.length > best.length && v.length > 80) {
        best = v;
      }
    }
    return best;
  }
  return '';
}

// ---------------------------------------------------------------------------
// 请求构造
// ---------------------------------------------------------------------------

function buildHeaders(key, custom) {
  const h = { Accept: 'application/json', 'User-Agent': UA };
  if (key) {
    h.Authorization = `Bearer ${key}`;
    h['X-API-KEY'] = key;
    h['x-api-key'] = key;
    h['X-Subscription-Token'] = key;
  }
  return { ...h, ...(custom && typeof custom === 'object' ? custom : {}) };
}

function postJson(url, key, body, custom) {
  return {
    url,
    init: {
      method: 'POST',
      headers: { ...buildHeaders(key, custom), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  };
}

function getWithParams(url, key, params, custom) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
  }
  return { url: u.toString(), init: { method: 'GET', headers: buildHeaders(key, custom) } };
}

export function buildRequest(provider, { url, key, query, count, headers }) {
  const n = Math.max(1, Math.min(10, count || 5));
  switch (provider) {
    case 'metaso':
      return postJson(url, key, { q: query, scope: 'webpage', includeSummary: false, size: n }, headers);
    case 'exa':
      return postJson(url, key, { query, numResults: n, contents: { text: { maxCharacters: 500 } } }, headers);
    case 'tavily':
      return postJson(url, key, { api_key: key, query, max_results: n, search_depth: 'basic', include_answer: false }, headers);
    case 'serper':
      return postJson(url, key, { q: query, num: n }, headers);
    case 'brave':
      return getWithParams(url, key, { q: query, count: n }, headers);
    case 'bing':
      return getWithParams(url, key, { q: query, count: n, mkt: 'zh-CN' }, headers);
    case 'google':
      return getWithParams(url, key, { q: query, num: n, key }, headers);
    case 'serpapi':
      return getWithParams(url, key, { q: query, num: n, api_key: key, engine: 'google' }, headers);
    default:
      return postJson(url, key, {
        query, q: query, count: n, num: n, num_results: n, max_results: n, limit: n, size: n,
      }, headers);
  }
}

export function buildFallbackGet(provider, { url, key, query, count, headers }) {
  const n = Math.max(1, Math.min(10, count || 5));
  return getWithParams(url, key, { q: query, query, count: n, num: n, limit: n, key }, headers);
}

function buildReaderPost({ url, key, targetUrl, format, headers }) {
  const body = { url: targetUrl };
  if (format) body.format = format;
  return postJson(url, key, body, headers);
}

function buildReaderGet({ url, key, targetUrl, format, headers }) {
  return getWithParams(url, key, { url: targetUrl, format: format || '' }, headers);
}

async function request({ url, init }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal, redirect: 'follow' });
    const body = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${body.slice(0, 160)}`);
    return { body, contentType: res.headers.get('content-type') || '' };
  } finally {
    clearTimeout(timer);
  }
}

function parseMaybeJson(body, contentType) {
  const t = String(body || '').trim();
  if (/json/i.test(contentType) || t.startsWith('{') || t.startsWith('[')) {
    try {
      return { json: JSON.parse(t) };
    } catch {
      return { text: t };
    }
  }
  return { text: t };
}

// ---------------------------------------------------------------------------
// 对外能力
// ---------------------------------------------------------------------------

// 关键词搜索,返回结构化结果(给面板测试、web_search 工具共用)
export async function searchRaw(cfg, query, count) {
  const q = String(query || '').trim();
  const n = Math.max(1, Math.min(10, count || cfg.searchResults || 5));
  if (!cfg.searchApiUrl) return { items: [], error: '联网搜索未配置(先填搜索地址和 Key)', provider: 'none' };
  const provider = detectProvider(cfg.searchApiUrl);
  const opts = { url: cfg.searchApiUrl, key: cfg.searchApiKey, query: q, count: n, headers: cfg.searchHeaders };
  const map = cfg.searchResponse || {};

  let items = [];
  let failure = '';
  try {
    const r = await request(buildRequest(provider, opts));
    items = extractResults(provider, parseMaybeJson(r.body, r.contentType).json, n, map);
  } catch (e) {
    failure = String(e?.message || e);
  }
  if (!items.length) {
    try {
      const r = await request(buildFallbackGet(provider, opts));
      items = extractResults(provider, parseMaybeJson(r.body, r.contentType).json, n, map);
      if (items.length) failure = '';
    } catch (e) {
      if (!failure) failure = String(e?.message || e);
    }
  }
  return { items, provider, error: failure };
}

// 读网页正文:优先走 /reader API;拿不到内容就返回 null(调用方自行决定要不要直抓)
export async function readPage(cfg, targetUrl, maxChars = 4000) {
  if (!cfg.readerApiUrl) return { error: '网页读取未配置' };
  const map = cfg.searchResponse || {};
  const opts = {
    url: cfg.readerApiUrl, key: cfg.searchApiKey, targetUrl,
    format: cfg.searchReaderFormat || '', headers: cfg.searchHeaders,
  };
  let failure = '';
  try {
    const r = await request(buildReaderPost(opts));
    const parsed = parseMaybeJson(r.body, r.contentType);
    const text = parsed.json ? pickContent(parsed.json, map.content) : String(parsed.text || '').trim();
    if (text && text.length > 20) return { text: truncate(text, maxChars), via: 'reader' };
    failure = '返回内容为空';
  } catch (e) {
    failure = String(e?.message || e);
  }
  try {
    const r = await request(buildReaderGet(opts));
    const parsed = parseMaybeJson(r.body, r.contentType);
    const text = parsed.json ? pickContent(parsed.json, map.content) : String(parsed.text || '').trim();
    if (text && text.length > 20) return { text: truncate(text, maxChars), via: 'reader-get' };
    failure = failure || '返回内容为空';
  } catch (e) {
    failure = failure || String(e?.message || e);
  }
  return { error: failure };
}

// Agent 工具 web_search 的输出
export async function webSearch(cfg, query, count) {
  const q = String(query || '').trim();
  if (!q) return '搜索关键词为空。';
  if (!cfg.searchEnabled) {
    return '管理员关闭了联网搜索。你可以直接用已有知识回答,或让用户自己提供资料。';
  }
  if (!cfg.searchApiUrl) {
    return '联网搜索未配置(需要填搜索地址和 Key),请告诉用户你暂时无法联网,'
      + '或者用 fetch_url 直接抓一个已知网址。';
  }

  const { items, provider, error } = await searchRaw(cfg, q, count);
  if (!items.length) {
    return `联网搜索没有拿到结果(服务商 ${provider})。${error ? `原因:${truncate(error, 200)}` : ''}\n`
      + '可以换个关键词再试,或者用 fetch_url 直接抓一个已知网址。';
  }

  const lines = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    let block = `${i + 1}. ${it.title || '(无标题)'}\n   ${it.url}`;
    if (it.snippet) block += `\n   ${truncate(it.snippet, 400)}`;
    lines.push(block);
  }

  // 合并模式:顺手把第一条结果的正文也读回来,省一次 fetch_url
  let merged = false;
  if (cfg.searchMergeReader && cfg.readerApiUrl && items[0]?.url) {
    const page = await readPage(cfg, items[0].url, 1200);
    if (page.text) {
      lines[0] += `\n   【正文】${page.text}`;
      merged = true;
    }
  }

  return `搜索「${q}」(来源:${provider}${merged ? ',已附第一条正文' : ''})\n${lines.join('\n')}`;
}

// 面板「一次测试两个」:搜索和网页读取各跑一遍,带原始返回片段方便配结构映射
export async function testSearch(cfg, opts = {}) {
  const query = String(opts.query || '人工智能 最新进展').slice(0, 80);
  const targetUrl = String(opts.url || 'https://example.com');
  const out = { search: {}, reader: {}, endpoints: { search: cfg.searchApiUrl || '', reader: cfg.readerApiUrl || '' } };

  const t0 = Date.now();
  try {
    const { items, provider, error } = await searchRaw(cfg, query, 3);
    out.search = {
      ok: items.length > 0,
      ms: Date.now() - t0,
      provider,
      count: items.length,
      items: items.slice(0, 3),
      error: error || '',
    };
  } catch (e) {
    out.search = { ok: false, ms: Date.now() - t0, error: String(e?.message || e) };
  }

  const t1 = Date.now();
  try {
    const r = await readPage(cfg, targetUrl, 800);
    out.reader = r.text
      ? { ok: true, ms: Date.now() - t1, via: r.via, sample: truncate(r.text, 300) }
      : { ok: false, ms: Date.now() - t1, error: r.error || '没有拿到正文' };
  } catch (e) {
    out.reader = { ok: false, ms: Date.now() - t1, error: String(e?.message || e) };
  }
  return out;
}
