// 统一的配置读取。所有值都来自 wrangler.toml 的 [vars] 或 wrangler secret。

const DEFAULTS = {
  QQ_APP_ID: '',
  QQ_APP_SECRET: '',
  QQ_API_BASE: 'https://api.bot.qq.com',
  QQ_TOKEN_URL: 'https://api.bot.qq.com/app/getAppAccessToken',
  WEBHOOK_PATH: '/qq/webhook',
  WEBHOOK_SECRET: '',
  VERIFY_SIGNATURE: 'true',

  LLM_BASE_URL: '',
  LLM_API_KEY: '',
  LLM_MODEL: 'deepseek-v4.1-flash',
  LLM_REASONING_EFFORT: 'max',
  LLM_FALLBACK_EFFORT: 'low',
  // 留空 = 不向网关传 max_tokens,由上游自己决定上限(推荐)。
  // 想限制就填数字,例如 "8192"。
  LLM_MAX_TOKENS: '',
  LLM_TIMEOUT_MS: '180000',
  AGENT_MAX_ROUNDS: '6',
  AGENT_MAX_TOOLS_PER_ROUND: '4',

  DASHBOARD_URL: '',

  PUBLIC_BASE_URL: '',
  DEPLOY_MAX_SITES: '6',
  DEPLOY_TTL_SECONDS: '600',
  DEPLOY_ID_CHARSET: 'ascii',
  DEPLOY_ID_LEN: '8',
  DEPLOY_MAX_BYTES: '200000',

  GATEWAY_MODE: 'webhook',
  // GUILDS(1) | GROUP_AND_C2C_EVENT(1<<25) | PUBLIC_GUILD_MESSAGES(1<<30)
  GATEWAY_INTENTS: '1107296257',

  CTX_KEEP_MESSAGES: '12',
  CTX_COMPRESS_CHARS: '6000',
  CTX_SUMMARY_CHARS: '2000',

  ADMIN_TOKEN: '',
};

const TRUEISH = new Set(['1', 'true', 'yes', 'on']);

function str(env, key) {
  const v = env?.[key];
  if (v === undefined || v === null) return DEFAULTS[key] ?? '';
  return String(v);
}

function int(env, key, min, max) {
  const n = parseInt(str(env, key), 10);
  const d = parseInt(DEFAULTS[key], 10);
  let v = Number.isFinite(n) ? n : d;
  if (min !== undefined && v < min) v = min;
  if (max !== undefined && v > max) v = max;
  return v;
}

function bool(env, key) {
  return TRUEISH.has(str(env, key).toLowerCase());
}

/**
 * 输出上限。
 * 0 = 不限制(请求里根本不带 max_tokens 字段),这是默认值 —— 上限会把长回答直接截断,
 * 而且 max 档思考一旦把预算烧完,正文就一个字都没有。
 * 只有你明确填了正整数才会带上这个字段。
 */
export function maxTokensFrom(env) {
  const raw = str(env, 'LLM_MAX_TOKENS').trim();
  if (!raw) return 0;
  const low = raw.toLowerCase();
  if (low === 'none' || low === 'unlimited' || low === 'off') return 0;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(200000, n);
}

export function loadConfig(env = {}) {
  return {
    appId: str(env, 'QQ_APP_ID'),
    appSecret: str(env, 'QQ_APP_SECRET'),
    apiBase: str(env, 'QQ_API_BASE').replace(/\/+$/, ''),
    tokenUrl: str(env, 'QQ_TOKEN_URL'),
    webhookPath: str(env, 'WEBHOOK_PATH') || '/qq/webhook',
    webhookSecret: str(env, 'WEBHOOK_SECRET'),
    verifySignature: bool(env, 'VERIFY_SIGNATURE'),

    llmBaseUrl: str(env, 'LLM_BASE_URL').replace(/\/+$/, ''),
    llmApiKey: str(env, 'LLM_API_KEY'),
    llmModel: str(env, 'LLM_MODEL'),
    reasoningEffort: str(env, 'LLM_REASONING_EFFORT'),
    fallbackEffort: str(env, 'LLM_FALLBACK_EFFORT'),
    maxTokens: maxTokensFrom(env),
    llmTimeoutMs: int(env, 'LLM_TIMEOUT_MS', 10000, 600000),
    agentMaxRounds: int(env, 'AGENT_MAX_ROUNDS', 1, 12),
    agentMaxToolsPerRound: int(env, 'AGENT_MAX_TOOLS_PER_ROUND', 1, 8),

    dashboardUrl: str(env, 'DASHBOARD_URL'),

    publicBaseUrl: str(env, 'PUBLIC_BASE_URL').replace(/\/+$/, ''),
    maxSites: int(env, 'DEPLOY_MAX_SITES', 1, 50),
    siteTtlSeconds: int(env, 'DEPLOY_TTL_SECONDS', 60, 86400),
    idCharset: str(env, 'DEPLOY_ID_CHARSET') || 'mixed',
    idLen: int(env, 'DEPLOY_ID_LEN', 4, 24),
    maxSiteBytes: int(env, 'DEPLOY_MAX_BYTES', 1024, 1500000),

    gatewayMode: str(env, 'GATEWAY_MODE') || 'webhook',
    gatewayIntents: int(env, 'GATEWAY_INTENTS', 0, 2147483647),

    keepMessages: int(env, 'CTX_KEEP_MESSAGES', 2, 60),
    compressChars: int(env, 'CTX_COMPRESS_CHARS', 500, 200000),
    summaryChars: int(env, 'CTX_SUMMARY_CHARS', 200, 8000),

    adminToken: str(env, 'ADMIN_TOKEN'),
  };
}

export { DEFAULTS };
