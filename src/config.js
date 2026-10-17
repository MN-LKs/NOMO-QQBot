export const FIXED = {
  apiBase: 'https://api.sgroup.qq.com',
  sandboxApiBase: 'https://sandbox.api.sgroup.qq.com',
  tokenUrl: 'https://bots.qq.com/app/getAppAccessToken',
  gatewayUrl: 'https://api.sgroup.qq.com/websocket/',
  webhookPath: '/qq/webhook',
  panelPath: '/administrator',
  llmTimeoutMs: 120000,
  agentMaxRounds: 6,
  agentMaxToolsPerRound: 4,
  agentBudgetMs: 0,
  idLen: 8,
  idCharset: 'ascii',
  maxFileBytes: 900000,
  keepMessages: 12,
  compressChars: 6000,
  summaryChars: 2000,
  searchResults: 5,
  answerDelivery: 'auto',
  chunkChars: 1500,
  sessionDays: 7,
  loginMaxFails: 5,
  loginLockMs: 15 * 60 * 1000,
  skillMaxInject: 6000,
  moduleMaxCode: 20000,
  siteApiPerMinute: 60,
};

export const ENV_VARS = ['ADMIN_USER', 'ADMIN_PASS'];

// 面板等自有页面的 CSP:不加载外部资源,只允许自身与内联脚本/样式
export const CSP_PANEL = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

// 部署页面是 AI 生成的:允许内联脚本/样式、https 与 wss 资源,但禁止 http 与插件
export const CSP_SITE = "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: https: wss:; object-src 'none'";

export const KV_TOTAL_BYTES = 1024 * 1024 * 1024;

export const ARCHITECTURES = ['html', 'prefab', 'custom'];

export const DEFAULT_SETTINGS = {
  llm: {
    baseUrl: '',
    apiKey: '',
    model: 'deepseek-v4.1-flash',
    headers: {},
    reasoningEffort: 'max',
    deepThinking: true,
    models: [],
    timeLimitEnabled: false,
    maxSeconds: 600,
    compressChars: 6000,
    systemPrompt: '',
    workflow: '',
  },
  search: {
    enabled: true,
    baseUrl: '',
    key: '',
    headers: {},
    results: 5,
    searchPath: '/search',
    readerPath: '/reader',
    readerFormat: '',
    mergeReader: true,
    response: { results: '', title: '', url: '', snippet: '', content: '' },
    provider: 'auto',
  },
  storage: {
    initialized: false,
    cacheKV: true,
    stores: [],
  },
  dashboard: { url: 'https://manage.nexacode.dpdns.org/api/dashboard' },
  qq: { appId: '', appSecret: '', mode: 'webhook', sandbox: false, intents: 33554432, answerDelivery: 'auto' },
  persona: '',
  admin: { openIds: [], groupAdmins: false },
  groups: {
    allowAll: false,
    list: [],
    cacheEnabled: true,
    cachePerGroup: 300,
    cacheRetentionDays: 7,
  },
  agent: {
    concurrency: 4,
    budgetSeconds: 0,
    architectures: ['html'],
  },
  deploy: {
    ttlSeconds: 600,
    extendSeconds: 600,
    maxProjects: 5,
    perProjectBytes: 64 * 1024 * 1024,
    reserveBytes: 64 * 1024 * 1024,
    dataQuotaBytes: 256 * 1024,
    writesPerDay: 200,
    maxPerDay: 50,
    allowData: true,
    apiPerMinute: 60,
  },
  logs: { debug: false, retentionDays: 7, maxRows: 8000 },
  site: { publicBaseUrl: '' },
};

function str(env, key) {
  const v = env?.[key];
  return v === undefined || v === null ? '' : String(v).trim();
}

export function loadEnv(env = {}) {
  return {
    adminUser: str(env, 'ADMIN_USER'),
    adminPass: str(env, 'ADMIN_PASS'),
    hasDB: !!env?.DB,
    hasKV: !!env?.STORE,
    hasR2: !!env?.R2,
    hasCore: !!env?.BOT_CORE,
  };
}

export function missingEnv(env = {}) {
  const missing = [];
  if (!str(env, 'ADMIN_USER')) missing.push('ADMIN_USER');
  if (!str(env, 'ADMIN_PASS')) missing.push('ADMIN_PASS');
  return missing;
}

export function deepMerge(base, patch) {
  if (patch === null || patch === undefined) return base;
  if (Array.isArray(base) || Array.isArray(patch)) return patch;
  if (typeof base !== 'object' || typeof patch !== 'object') return patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = k in base ? deepMerge(base[k], v) : v;
  }
  return out;
}

export function trimSlash(s) {
  return String(s || '').replace(/\/+$/, '');
}

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
// 本地/内网地址保留 http,其余 http 一律升级成 https
const LOCAL_HOST_RE = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)(?::\d+)?(?:\/|$)/i;

/**
 * 把用户随手填的地址整理成可用的绝对地址:
 * - 没写协议(api.x.com/v1)→ 自动补 https://
 * - 写成 //api.x.com/v1 → 补 https:
 * - 去掉结尾多余的斜杠
 * - httpsOnly 时把公网 http 升级成 https(本地/内网地址保持原样)
 */
export function normalizeBaseUrl(raw, { httpsOnly = false } = {}) {
  let s = String(raw === null || raw === undefined ? '' : raw).trim();
  if (!s) return '';
  if (s.startsWith('//')) s = 'https:' + s;
  if (!SCHEME_RE.test(s)) s = 'https://' + s;
  s = s.replace(/\/+$/, '');
  // 只写了协议、没有主机名(比如 https://)时当作空
  if (/^[a-z][a-z0-9+.-]*:$/i.test(s)) return '';
  if (httpsOnly && /^http:\/\//i.test(s) && !LOCAL_HOST_RE.test(s.slice(7))) {
    s = 'https://' + s.slice(7);
  }
  return s;
}

/**
 * AI 接口地址的整理:在 normalizeBaseUrl 之上,再容忍用户把
 * 完整的 /chat/completions 粘进来(否则会拼成 .../chat/completions/chat/completions)。
 */
export function normalizeApiBase(raw) {
  let s = normalizeBaseUrl(raw);
  s = s.replace(/\/chat\/completions\/?$/i, '');
  return trimSlash(s);
}

/**
 * 从一个「带 /v1 的 url」推导出搜索与网页读取两个端点。
 * 例:https://api.x.com/v1 -> search=https://api.x.com/v1/search, reader=https://api.x.com/v1/reader
 * 如果用户直接填了带 /search 或 /reader 后缀的地址,就按填的来。
 */
export function deriveEndpoints(baseUrl, searchPath = '/search', readerPath = '/reader') {
  let base = trimSlash(normalizeBaseUrl(baseUrl));
  let sp = String(searchPath || '/search').trim() || '/search';
  let rp = String(readerPath || '/reader').trim() || '/reader';
  if (!sp.startsWith('/')) sp = '/' + sp;
  if (!rp.startsWith('/')) rp = '/' + rp;
  if (base.endsWith(sp)) base = base.slice(0, -sp.length);
  else if (base.endsWith(rp)) base = base.slice(0, -rp.length);
  base = trimSlash(base);
  return {
    base,
    searchUrl: base ? `${base}${sp}` : '',
    readerUrl: base ? `${base}${rp}` : '',
  };
}

export function flatten(settings, env = {}) {
  const e = loadEnv(env);
  const llm = settings.llm || {};
  const qq = settings.qq || {};
  const dep = settings.deploy || {};
  const search = settings.search || {};
  const groups = settings.groups || {};
  const agent = settings.agent || {};
  const sandbox = qq.sandbox === true;
  const override = env?.QQ_API_BASE ? String(env.QQ_API_BASE).replace(/\/+$/, '') : '';
  const apiBase = override || (sandbox ? FIXED.sandboxApiBase : FIXED.apiBase);
  const tokenUrl = override ? `${override}/app/getAppAccessToken` : FIXED.tokenUrl;
  const endpoints = deriveEndpoints(search.baseUrl, search.searchPath, search.readerPath);
  const architectures = Array.isArray(agent.architectures)
    ? agent.architectures.filter((a) => ARCHITECTURES.includes(a))
    : ['html'];
  return {
    ...FIXED,
    apiBase,
    tokenUrl,
    gatewayUrl: `${apiBase}/websocket/`,
    sandbox,
    adminUser: e.adminUser,
    adminPass: e.adminPass,
    appId: String(qq.appId || '').trim(),
    appSecret: String(qq.appSecret || '').trim(),
    mode: qq.mode === 'websocket' ? 'websocket' : 'webhook',
    intents: Number(qq.intents) || 33554432,
    llmBaseUrl: normalizeApiBase(llm.baseUrl),
    llmApiKey: String(llm.apiKey || '').trim(),
    llmModel: String(llm.model || 'deepseek-v4.1-flash').trim(),
    llmHeaders: llm.headers && typeof llm.headers === 'object' ? llm.headers : {},
    reasoningEffort: llm.deepThinking === false ? 'none' : (llm.reasoningEffort || 'max'),
    deepThinking: llm.deepThinking !== false,
    systemPrompt: String(llm.systemPrompt || ''),
    workflow: String(llm.workflow || ''),
    searchEnabled: search.enabled !== false,
    searchBaseUrl: endpoints.base,
    searchApiUrl: endpoints.searchUrl,
    readerApiUrl: endpoints.readerUrl,
    searchApiKey: String(search.key || '').trim(),
    searchHeaders: search.headers && typeof search.headers === 'object' ? search.headers : {},
    searchResults: Math.max(1, Math.min(10, Number(search.results) || FIXED.searchResults)),
    searchMergeReader: search.mergeReader !== false,
    searchReaderFormat: String(search.readerFormat || ''),
    searchResponse: search.response && typeof search.response === 'object' ? search.response : {},
    searchProvider: String(search.provider || 'auto'),
    storageStores: Array.isArray(settings.storage?.stores) ? settings.storage.stores : [],
    storageCacheKV: settings.storage?.cacheKV !== false,
    dashboardUrl: String(settings.dashboard?.url || '').trim(),
    persona: String(settings.persona || ''),
    publicBaseUrl: normalizeBaseUrl(settings.site?.publicBaseUrl, { httpsOnly: true }),
    llmTimeLimitEnabled: llm.timeLimitEnabled === true,
    llmMaxSeconds: Math.max(5, Number(llm.maxSeconds) || 600),
    compressChars: Math.max(1000, Number(llm.compressChars) || FIXED.compressChars),
    answerDelivery: qq.answerDelivery === 'active' ? 'active' : 'auto',
    agentConcurrency: Math.max(1, Math.min(10, Number(agent.concurrency) || 4)),
    agentBudgetMs: Math.max(0, Number(agent.budgetSeconds) || 0) * 1000,
    architectures,
    canDeploy: architectures.includes('html') || architectures.includes('prefab') || architectures.includes('custom'),
    canPrefab: architectures.includes('prefab'),
    canCustomBackend: architectures.includes('custom'),
    groupsCacheEnabled: groups.cacheEnabled !== false,
    groupsCachePerGroup: Math.max(20, Math.min(2000, Number(groups.cachePerGroup) || 300)),
    groupsCacheRetentionDays: Math.max(1, Math.min(90, Number(groups.cacheRetentionDays) || 7)),
    maxSites: Number(dep.maxProjects) || 5,
    idLen: FIXED.idLen,
    idCharset: FIXED.idCharset,
    siteTtlSeconds: Number(dep.ttlSeconds) || 600,
    extendSeconds: Number(dep.extendSeconds) || 600,
    perProjectBytes: Number(dep.perProjectBytes) || 64 * 1024 * 1024,
    reserveBytes: Number(dep.reserveBytes) || 64 * 1024 * 1024,
    dataQuotaBytes: Number(dep.dataQuotaBytes) || 256 * 1024,
    allowData: dep.allowData !== false,
    apiPerMinute: Math.max(10, Math.min(600, Number(dep.apiPerMinute) || FIXED.siteApiPerMinute)),
    settings,
  };
}
