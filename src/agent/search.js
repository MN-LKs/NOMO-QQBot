import { truncate } from '../util/text.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const TIMEOUT_MS = 15000;

const URL_KEYS = ['url', 'link', 'href', 'uri', 'source_url', 'sourceUrl', 'page_url', 'pageUrl'];
const TITLE_KEYS = ['title', 'name', 'heading', 'headline'];
const SNIPPET_KEYS = ['snippet', 'description', 'summary', 'content', 'text', 'abstract', 'desc'];

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

function authHeaders(key) {
  const h = { Accept: 'application/json', 'User-Agent': UA };
  if (key) {
    h.Authorization = `Bearer ${key}`;
    h['X-API-KEY'] = key;
    h['x-api-key'] = key;
    h['X-Subscription-Token'] = key;
    h['Ocp-Apim-Subscription-Key'] = key;
  }
  return h;
}

function postJson(url, key, body, extra = {}) {
  return {
    url,
    init: {
      method: 'POST',
      headers: { ...authHeaders(key), 'Content-Type': 'application/json', ...extra },
      body: JSON.stringify(body),
    },
  };
}

function getWithParams(url, key, params, extra = {}) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
  }
  return { url: u.toString(), init: { method: 'GET', headers: { ...authHeaders(key), ...extra } } };
}

export function buildRequest(provider, { url, key, query, count }) {
  const n = Math.max(1, Math.min(10, count || 5));
  switch (provider) {
    case 'metaso':
      return postJson(url, key, { q: query, scope: 'webpage', includeSummary: false, size: n });
    case 'exa':
      return postJson(url, key, { query, numResults: n, contents: { text: { maxCharacters: 500 } } });
    case 'tavily':
      return postJson(url, key, { api_key: key, query, max_results: n, search_depth: 'basic', include_answer: false });
    case 'serper':
      return postJson(url, key, { q: query, num: n });
    case 'brave':
      return getWithParams(url, key, { q: query, count: n });
    case 'bing':
      return getWithParams(url, key, { q: query, count: n, mkt: 'zh-CN' });
    case 'google':
      return getWithParams(url, key, { q: query, num: n, key });
    case 'serpapi':
      return getWithParams(url, key, { q: query, num: n, api_key: key, engine: 'google' });
    default:
      return postJson(url, key, {
        query, q: query, count: n, num: n, num_results: n, max_results: n, limit: n,
      });
  }
}

export function buildFallbackGet(provider, { url, key, query, count }) {
  const n = Math.max(1, Math.min(10, count || 5));
  return getWithParams(url, key, { q: query, query, count: n, num: n, limit: n, key });
}

function urlOf(o) {
  for (const k of URL_KEYS) {
    const v = o?.[k];
    if (typeof v === 'string' && /^https?:\/\//i.test(v)) return v;
  }
  return '';
}

function firstText(o, keys) {
  for (const k of keys) {
    const v = o?.[k];
    if (typeof v === 'string' && v.trim()) return v;
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

export function extractResults(provider, json, limit = 5) {
  let list = null;
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
  if (!Array.isArray(list) || !list.some(urlOf)) list = pickList(json);

  const out = [];
  const seen = new Set();
  for (const item of list || []) {
    const url = urlOf(item);
    if (!url) continue;
    const key = url.replace(/#.*$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      title: firstText(item, TITLE_KEYS).replace(/\s+/g, ' ').trim(),
      url,
      snippet: firstText(item, SNIPPET_KEYS).replace(/\s+/g, ' ').trim(),
    });
    if (out.length >= limit) break;
  }
  return out;
}

async function request({ url, init }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal, redirect: 'follow' });
    const body = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${body.slice(0, 160)}`);
    try {
      return JSON.parse(body);
    } catch {
      throw new Error(`返回的不是 JSON(可能是网址填错了):${body.slice(0, 160)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function webSearch(cfg, query, count) {
  const q = String(query || '').trim();
  if (!q) return '搜索关键词为空。';
  if (!cfg.searchApiUrl) {
    return '联网搜索未配置(缺少 SEARCH_API_URL / SEARCH_API_KEY),请先告诉用户你无法联网,'
      + '或者用 fetch_url 直接抓一个已知网址。';
  }

  const provider = detectProvider(cfg.searchApiUrl);
  const n = Math.max(1, Math.min(10, count || cfg.searchResults || 5));
  const opts = { url: cfg.searchApiUrl, key: cfg.searchApiKey, query: q, count: n };

  let items = [];
  let failure = '';
  try {
    items = extractResults(provider, await request(buildRequest(provider, opts)), n);
  } catch (e) {
    failure = String(e?.message || e);
  }

  if (!items.length) {
    try {
      const r = await request(buildFallbackGet(provider, opts));
      items = extractResults(provider, r, n);
    } catch (e) {
      if (!failure) failure = String(e?.message || e);
    }
  }

  if (!items.length) {
    return `联网搜索没有拿到结果(服务商 ${provider})。${failure ? `原因:${truncate(failure, 200)}` : ''}\n`
      + '可以换个关键词再试,或者用 fetch_url 直接抓一个已知网址。';
  }

  const lines = items.map((it, i) => `${i + 1}. ${it.title || '(无标题)'}\n   ${it.url}`
    + (it.snippet ? `\n   ${truncate(it.snippet, 400)}` : ''));
  return `搜索「${q}」(来源:${provider})\n${lines.join('\n')}`;
}
