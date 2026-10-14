const ASCII_POOL = 'abcdefghjkmnpqrstuvwxyz23456789';
const CJK_POOL = '云星智创码引擎光速飞天地人和心梦灵犀翼航舟雨风雷电海山月日新古奇特异能幻影音律诗歌画卷轴';

export const DEFAULT_ID_LEN = 8;

function pick(pool, n, out) {
  const max = 256 - (256 % pool.length);
  for (let i = 0; i < n; i++) {
    let v;
    do {
      v = randomByte();
    } while (v >= max);
    out.push(pool[v % pool.length]);
  }
}

function randomByte() {
  const b = new Uint8Array(1);
  crypto.getRandomValues(b);
  return b[0];
}

export function genSiteId(len = DEFAULT_ID_LEN, charset = 'mixed') {
  const n = Math.max(4, Math.min(24, len | 0));
  const out = [];
  if (charset === 'ascii') {
    pick(ASCII_POOL, n, out);
  } else if (charset === 'cjk') {
    pick(CJK_POOL, n, out);
  } else {
    pick(ASCII_POOL, 3, out);
    pick(CJK_POOL, 1, out);
    pick(ASCII_POOL + CJK_POOL, n - 4, out);
    for (let i = out.length - 1; i > 0; i--) {
      const j = randomByte() % (i + 1);
      const t = out[i];
      out[i] = out[j];
      out[j] = t;
    }
  }
  return out.join('');
}

export const RESERVED_PATHS = new Set([
  'qq', 'api', 'admin', 'health', 'check', 'favicon.ico', 'robots.txt',
  'index', 's', 'd', 'static', 'assets', '__data', 'cron', 'favicon.png',
  'www', 'app', 'login', 'logout', 'null', 'undefined', 'test',
]);

export function isReservedPath(id) {
  if (!id) return true;
  if (RESERVED_PATHS.has(id.toLowerCase())) return true;
  return id.length < 4;
}

const SITE_ID_RE = /^[a-z0-9\u4e00-\u9fff]{4,24}$/;

/**
 * 站点 ID 的合法形状:小写字母 / 数字 / 汉字,长度 4~24,与 genSiteId 的生成规则对齐。
 * 放在路由层用,可以在碰数据库之前就把扫描器路径(如 /env.dev、/.env)挡成 404。
 */
export function isSiteId(id) {
  return SITE_ID_RE.test(String(id || ''));
}
