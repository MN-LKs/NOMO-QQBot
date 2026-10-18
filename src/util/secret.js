// 密钥的读写规则,集中放在这里,避免各处再各写一份。
//
// 背景(真实事故):面板为了安全,GET /settings 时会把密钥打成 sk-z********6pAm 再返回。
// 前端把这个掩码直接塞进 input 的 value,用户点「模型列表」「测试」时又原样发回后端,
// 后端拿它就当成了真 Key 去请求上游 → 401;保存时也可能把掩码写进数据库。
//
// 所以定死两条规则:
//   1. 掩码(含 ****)和空值一律表示「不修改」,一律回退到已存的值;
//   2. 只有明确的新值才写入。要清空请显式传 CLEAR_SENTINEL。

export const CLEAR_SENTINEL = '__CLEAR__';

const MASK_RE = /\*{4,}/;

/** 是不是面板打出来的掩码值 */
export function isMasked(v) {
  return MASK_RE.test(String(v ?? ''));
}

/**
 * 决定最终要用的密钥:
 * - 掩码 / 空 / 未传 → 用已存的(即「不修改」)
 * - CLEAR_SENTINEL → 清空
 * - 其它 → 用新值
 */
export function resolveSecret(incoming, stored) {
  const s = String(incoming ?? '').trim();
  const cur = String(stored ?? '');
  if (!s) return cur;
  if (s === CLEAR_SENTINEL) return '';
  if (isMasked(s)) return cur;
  return s;
}

/** 打码:只用于展示,永不回写 */
export function maskValue(v) {
  const s = String(v || '');
  if (!s) return '';
  if (s.length <= 8) return '********';
  return `${s.slice(0, 4)}********${s.slice(-4)}`;
}

/** 真 Key 长这样;掩码进来的话要能一眼看出问题 */
export function looksLikeUsableKey(v) {
  const s = String(v || '').trim();
  return !!s && !isMasked(s);
}
