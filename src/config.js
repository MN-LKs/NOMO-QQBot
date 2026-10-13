const FIXED = {
  apiBase: 'https://api.bot.qq.com',
  tokenUrl: 'https://api.bot.qq.com/app/getAppAccessToken',
  webhookPath: '/qq/webhook',
  llmModel: 'deepseek-v4.1-flash',
  reasoningEffort: 'max',
  fallbackEffort: 'low',
  llmTimeoutMs: 120000,
  agentMaxRounds: 6,
  agentMaxToolsPerRound: 4,
  agentBudgetMs: 240000,
  maxSites: 6,
  siteTtlSeconds: 600,
  idLen: 8,
  idCharset: 'ascii',
  maxSiteBytes: 200000,
  keepMessages: 12,
  compressChars: 6000,
  summaryChars: 2000,
  searchResults: 5,
  dashboardUrl: 'https://manage.nexacode.dpdns.org/api/dashboard',
  answerDelivery: 'active',
};

export const REQUIRED_VARS = ['QQ_APP_ID', 'QQ_APP_SECRET', 'LLM_BASE_URL', 'LLM_API_KEY'];

export const OPTIONAL_VARS = ['SEARCH_API_URL', 'SEARCH_API_KEY', 'PUBLIC_BASE_URL'];

export const ALL_VARS = [...REQUIRED_VARS, ...OPTIONAL_VARS];

export { FIXED };

function str(env, key) {
  const v = env?.[key];
  return v === undefined || v === null ? '' : String(v).trim();
}

function trimSlash(s) {
  return String(s).replace(/\/+$/, '');
}

export function loadConfig(env = {}) {
  return {
    appId: str(env, 'QQ_APP_ID'),
    appSecret: str(env, 'QQ_APP_SECRET'),
    llmBaseUrl: trimSlash(str(env, 'LLM_BASE_URL')),
    llmApiKey: str(env, 'LLM_API_KEY'),
    searchApiUrl: str(env, 'SEARCH_API_URL'),
    searchApiKey: str(env, 'SEARCH_API_KEY'),
    publicBaseUrl: trimSlash(str(env, 'PUBLIC_BASE_URL')),
    ...FIXED,
  };
}

export function missingVars(cfg) {
  const missing = [];
  if (!cfg.appId) missing.push('QQ_APP_ID');
  if (!cfg.appSecret) missing.push('QQ_APP_SECRET');
  if (!cfg.llmBaseUrl) missing.push('LLM_BASE_URL');
  if (!cfg.llmApiKey) missing.push('LLM_API_KEY');
  return missing;
}
