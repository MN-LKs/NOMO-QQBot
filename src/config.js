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
};

export const ENV_VARS = ['ADMIN_USER', 'ADMIN_PASS'];

export const KV_TOTAL_BYTES = 1024 * 1024 * 1024;

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
  },
  search: { url: '', key: '', headers: {}, results: 5 },
  extract: { url: '', key: '', headers: {}, format: '' },
  dashboard: { url: 'https://manage.nexacode.dpdns.org/api/dashboard' },
  qq: { appId: '', appSecret: '', mode: 'websocket', sandbox: false, intents: 33554432, answerDelivery: 'auto' },
  persona: '',
  admin: { openIds: [], groupAdmins: false },
  groups: { allowAll: false, list: [] },
  agent: { concurrency: 4, budgetSeconds: 0 },
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

export function flatten(settings, env = {}) {
  const e = loadEnv(env);
  const llm = settings.llm || {};
  const qq = settings.qq || {};
  const dep = settings.deploy || {};
  const sandbox = qq.sandbox === true;
  const override = env?.QQ_API_BASE ? String(env.QQ_API_BASE).replace(/\/+$/, '') : '';
  const apiBase = override || (sandbox ? FIXED.sandboxApiBase : FIXED.apiBase);
  const tokenUrl = override ? `${override}/app/getAppAccessToken` : FIXED.tokenUrl;
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
    mode: qq.mode === 'webhook' ? 'webhook' : 'websocket',
    intents: Number(qq.intents) || 33554432,
    llmBaseUrl: trimSlash(llm.baseUrl),
    llmApiKey: String(llm.apiKey || '').trim(),
    llmModel: String(llm.model || 'deepseek-v4.1-flash').trim(),
    llmHeaders: llm.headers && typeof llm.headers === 'object' ? llm.headers : {},
    reasoningEffort: llm.deepThinking === false ? 'none' : (llm.reasoningEffort || 'max'),
    deepThinking: llm.deepThinking !== false,
    searchApiUrl: String(settings.search?.url || '').trim(),
    searchApiKey: String(settings.search?.key || '').trim(),
    searchHeaders: settings.search?.headers && typeof settings.search.headers === 'object' ? settings.search.headers : {},
    searchResults: Math.max(1, Math.min(10, Number(settings.search?.results) || FIXED.searchResults)),
    extractUrl: trimSlash(settings.extract?.url),
    extractKey: String(settings.extract?.key || '').trim(),
    extractHeaders: settings.extract?.headers && typeof settings.extract.headers === 'object' ? settings.extract.headers : {},
    extractFormat: String(settings.extract?.format || '').trim(),
    dashboardUrl: String(settings.dashboard?.url || '').trim(),
    persona: String(settings.persona || ''),
    publicBaseUrl: trimSlash(settings.site?.publicBaseUrl),
    llmTimeLimitEnabled: llm.timeLimitEnabled === true,
    llmMaxSeconds: Math.max(5, Number(llm.maxSeconds) || 600),
    compressChars: Math.max(1000, Number(llm.compressChars) || FIXED.compressChars),
    answerDelivery: qq.answerDelivery === 'active' ? 'active' : 'auto',
    agentConcurrency: Math.max(1, Math.min(10, Number(settings.agent?.concurrency) || 4)),
    agentBudgetMs: Math.max(0, Number(settings.agent?.budgetSeconds) || 0) * 1000,
    maxSites: Number(dep.maxProjects) || 5,
    idLen: FIXED.idLen,
    idCharset: FIXED.idCharset,
    siteTtlSeconds: Number(dep.ttlSeconds) || 600,
    extendSeconds: Number(dep.extendSeconds) || 600,
    perProjectBytes: Number(dep.perProjectBytes) || 64 * 1024 * 1024,
    reserveBytes: Number(dep.reserveBytes) || 64 * 1024 * 1024,
    dataQuotaBytes: Number(dep.dataQuotaBytes) || 256 * 1024,
    allowData: dep.allowData !== false,
    settings,
  };
}
