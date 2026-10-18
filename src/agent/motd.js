const DEFAULT_TEXT_API = 'https://motd.txssb.cn/api/status';
const FALLBACK_TEXT_API = 'https://api.mcsrvstat.us/3/';
const UA = 'NOMO-QQBot/4.0';

export function parseMotdTarget(input) {
  let s = String(input || '').trim();
  if (!s) return { error: '请提供服务器地址,例如 /motd play.example.com 或 /motd play.example.com:25565' };
  s = s.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  let host = s;
  let port = '';
  if (s.startsWith('[')) {
    const end = s.indexOf(']');
    if (end < 0) return { error: 'IPv6 地址缺少右括号' };
    host = s.slice(1, end);
    const rest = s.slice(end + 1);
    if (rest.startsWith(':')) port = rest.slice(1);
  } else {
    const parts = s.split(':');
    if (parts.length === 2 && /^\d+$/.test(parts[1])) {
      host = parts[0];
      port = parts[1];
    }
  }
  host = host.trim();
  if (!host || host.length > 253) return { error: '服务器地址不合法' };
  if (!/^[a-zA-Z0-9._-]+$/.test(host) && !host.includes(':')) return { error: '服务器地址不合法' };
  if (port) {
    const n = Number(port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) return { error: '端口必须是 1-65535' };
  }
  return { host, port };
}

function buildUrl(api, host, port, extra = {}) {
  let u;
  try {
    u = new URL(api);
  } catch {
    return '';
  }
  u.searchParams.set('ip', host);
  if (port) u.searchParams.set('port', String(port));
  // 有些自建接口只认 host,这里一并带上;示例接口会忽略多余参数。
  if (!u.searchParams.has('host')) u.searchParams.set('host', host);
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
  }
  return u.toString();
}

async function request(url, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), Math.max(1000, Number(timeoutMs) || 8000));
  try {
    return await fetch(url, {
      signal: ctl.signal,
      headers: { 'User-Agent': UA, 'Accept': 'application/json,image/*,*/*' },
    });
  } finally {
    clearTimeout(timer);
  }
}

function stripColors(s) {
  return String(s || '').replace(/§[0-9a-fk-or]/gi, '').replace(/\r/g, '');
}

function motdText(data) {
  if (typeof data?.pureMotd === 'string') return stripColors(data.pureMotd);
  if (typeof data?.motd === 'string') return stripColors(data.motd);
  if (Array.isArray(data?.motd?.clean)) return stripColors(data.motd.clean.join('\n'));
  if (Array.isArray(data?.motd)) return stripColors(data.motd.join('\n'));
  return '';
}

function normalize(data, host, port) {
  if (!data || typeof data !== 'object') return null;
  if (data.status === 'offline' || data.online === false) {
    return {
      ok: true,
      online: false,
      host: String(data.host || `${host}${port ? `:${port}` : ''}`),
      type: data.type || '',
      raw: data,
    };
  }
  const players = data.players && typeof data.players === 'object' ? data.players : {};
  const online = data.status === 'online'
    || data.online === true
    || Number.isFinite(Number(players.online))
    || typeof data.version === 'string'
    || (data.version && typeof data.version === 'object');
  if (!online) return null;
  const version = typeof data.version === 'string'
    ? data.version
    : (data.version?.name || data.protocol?.name || data.protocol || '');
  return {
    ok: true,
    online: true,
    host: String(data.host || `${host}${port ? `:${port}` : ''}`),
    type: String(data.type || (data.debug?.bedrock ? 'Bedrock' : 'Java')),
    motd: motdText(data),
    version: String(version || ''),
    players: {
      online: Number(players.online) || 0,
      max: Number(players.max) || 0,
    },
    delay: Number(data.delay ?? data.debug?.ping) || 0,
    gamemode: String(data.gamemode || ''),
    levelname: String(data.levelname || data.map || ''),
    icon: String(data.icon || ''),
    raw: data,
  };
}

export async function queryMotd(cfg, host, port = '') {
  if (cfg?.motdEnabled === false) return { ok: false, error: 'MOTD 查询已在面板关闭' };
  const textApi = String(cfg?.motdTextApi || DEFAULT_TEXT_API).trim();
  const timeoutMs = Math.max(2000, Math.min(30000, Number(cfg?.motdTimeoutMs) || 8000));
  const urls = [];
  if (textApi) {
    const u = buildUrl(textApi, host, port);
    if (u) urls.push(u);
  }
  if (textApi !== FALLBACK_TEXT_API) {
    urls.push(`${FALLBACK_TEXT_API}${encodeURIComponent(host)}${port ? `?port=${encodeURIComponent(port)}` : ''}`);
  }
  const seen = new Set();
  for (const u of urls) {
    if (seen.has(u)) continue;
    seen.add(u);
    try {
      const res = await request(u, timeoutMs);
      if (!res.ok) continue;
      const ct = String(res.headers.get('content-type') || '');
      if (!ct.includes('json') && !ct.includes('text')) continue;
      const data = await res.json();
      const n = normalize(data, host, port);
      if (n) return n;
    } catch {
      /* 换下一个源 */
    }
  }
  return { ok: false, error: '查询失败:服务器可能离线,或者地址/端口不正确' };
}

export function formatMotdText(r) {
  if (!r || !r.ok) return `MOTD 查询失败:${r?.error || '未知错误'}`;
  const lines = [`${r.online ? '🟢 在线' : '🔴 离线'} · ${r.host}`];
  if (r.type) lines.push(`类型:${r.type}`);
  if (r.motd) lines.push(`MOTD:${r.motd.replace(/\n+/g, ' / ').slice(0, 500)}`);
  if (r.version) lines.push(`版本:${r.version}`);
  if (r.online) lines.push(`玩家:${r.players?.online ?? 0} / ${r.players?.max || '?'}`);
  if (r.delay) lines.push(`延迟:${r.delay}ms`);
  if (r.gamemode) lines.push(`模式:${r.gamemode}`);
  if (r.levelname) lines.push(`地图:${r.levelname}`);
  return lines.join('\n').slice(0, 1200);
}

export async function fetchMotdImage(cfg, host, port = '') {
  const api = String(cfg?.motdImageApi || '').trim();
  if (!api) return null;
  const u = buildUrl(api, host, port, { theme: cfg?.motdImageTheme || '' });
  if (!u) return null;
  try {
    const res = await request(u, cfg?.motdTimeoutMs || 8000);
    if (!res.ok) return null;
    const ct = String(res.headers.get('content-type') || '');
    if (!ct.startsWith('image/')) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length < 100 || bytes.length > 4 * 1024 * 1024) return null;
    return { bytes, contentType: ct };
  } catch {
    return null;
  }
}
