// 站点 ID 生成。默认「中英文混合 8 字符」,和需求里
// https://ai.example.com/<一串8个字符,包含中英文> 一致。

// 纯英文数字:去掉了容易看错的 0/o/l/1/i
const ASCII_POOL = 'abcdefghjkmnpqrstuvwxyz23456789';
// 常用中文,笔画简单、看着干净
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

/**
 * @param {number} len 长度
 * @param {'ascii'|'mixed'|'cjk'} charset
 */
export function genSiteId(len = DEFAULT_ID_LEN, charset = 'mixed') {
  const n = Math.max(4, Math.min(24, len | 0));
  const out = [];
  if (charset === 'ascii') {
    pick(ASCII_POOL, n, out);
  } else if (charset === 'cjk') {
    pick(CJK_POOL, n, out);
  } else {
    // mixed:保证至少 3 个英文数字 + 至少 1 个中文,其余随机
    pick(ASCII_POOL, 3, out);
    pick(CJK_POOL, 1, out);
    pick(ASCII_POOL + CJK_POOL, n - 4, out);
    // 打散,避免英文永远在前三位
    for (let i = out.length - 1; i > 0; i--) {
      const j = randomByte() % (i + 1);
      const t = out[i];
      out[i] = out[j];
      out[j] = t;
    }
  }
  return out.join('');
}

/** 这些路径留给机器人自己用,不能当站点 ID */
export const RESERVED_PATHS = new Set([
  'qq', 'api', 'admin', 'health', 'check', 'favicon.ico', 'robots.txt',
  'index', 's', 'd', 'static', 'assets', '__data', 'cron', 'favicon.png',
  'www', 'app', 'login', 'logout', 'null', 'undefined', 'test',
]);

export function isReservedPath(id) {
  if (!id) return true;
  if (RESERVED_PATHS.has(id.toLowerCase())) return true;
  // 只有一个 ascii 字符之类的太短也不行
  return id.length < 4;
}
