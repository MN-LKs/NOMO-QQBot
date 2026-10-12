// 腾讯 QQ 机器人回调的 Ed25519 签名 / 验签。
//
// 官方算法(见 bot.q.qq.com 文档「安全和授权」):
//   1. seed = BotSecret 反复翻倍,直到字节数 >= 32,取前 32 字节
//   2. 用 seed 生成 Ed25519 密钥对
//   3. op=13 回调验证:签名对象 = event_ts + plain_token,返回 hex 签名
//   4. 普通事件:签名对象 = X-Signature-Timestamp + HTTP Body(原始字节)
//
// Workers 的 Web Crypto 从 2023-04 起支持 Ed25519(Secure Curves)。
// 私钥用 PKCS#8 包装 import,公钥从导出 JWK 的 x 字段拿。

import { bytesToHex, concatBytes, hexToBytes, utf8 } from '../util/bytes.js';

// PKCS#8 前缀:SEQUENCE + version 0 + OID 1.3.101.112 + OCTET STRING(32)
const PKCS8_PREFIX = hexToBytes('302e020100300506032b657004220420');

const keyCache = new Map();

/** 按官方规则把 BotSecret 展开成 32 字节 seed */
export function seedFromSecret(secret) {
  let seed = utf8(String(secret ?? ''));
  if (seed.length === 0) throw new Error('BotSecret 为空');
  let guard = 0;
  while (seed.length < 32) {
    if (guard++ > 12) throw new Error('BotSecret 太短,无法展开到 32 字节');
    seed = concatBytes(seed, seed);
  }
  return seed.slice(0, 32);
}

/**
 * 拿到 { privateKey, publicKey }。同一 secret 只算一次。
 * @returns {Promise<{privateKey: CryptoKey, publicKey: CryptoKey, publicRaw: Uint8Array}>}
 */
export async function keysFromSecret(secret) {
  const cacheKey = String(secret);
  if (keyCache.has(cacheKey)) return keyCache.get(cacheKey);

  const seed = seedFromSecret(secret);
  const pkcs8 = concatBytes(PKCS8_PREFIX, seed);
  const privateKey = await crypto.subtle.importKey(
    'pkcs8', pkcs8, { name: 'Ed25519' }, true, ['sign'],
  );
  // Ed25519 私钥导出 JWK 时会带上公钥 x(32 字节,base64url)
  const jwk = await crypto.subtle.exportKey('jwk', privateKey);
  const publicRaw = b64urlDecode(jwk.x);
  const publicKey = await crypto.subtle.importKey(
    'raw', publicRaw, { name: 'Ed25519' }, false, ['verify'],
  );
  const out = { privateKey, publicKey, publicRaw };
  keyCache.set(cacheKey, out);
  return out;
}

function b64urlDecode(s) {
  let t = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (t.length % 4) t += '=';
  const bin = atob(t);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** op=13 回调地址验证:对 event_ts + plain_token 签名,返回 hex */
export async function signValidation(secret, eventTs, plainToken) {
  const { privateKey } = await keysFromSecret(secret);
  const msg = utf8(String(eventTs) + String(plainToken));
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, msg);
  return bytesToHex(new Uint8Array(sig));
}

/**
 * 校验回调请求签名。
 * @returns {Promise<{ok:boolean, reason?:string}>} ok=false 表示明确被篡改/伪造
 */
export async function verifyWebhook(secret, signatureHex, timestamp, rawBody) {
  if (!signatureHex) return { ok: false, reason: 'missing X-Signature-Ed25519' };
  if (!timestamp) return { ok: false, reason: 'missing X-Signature-Timestamp' };

  let sig;
  try {
    sig = hexToBytes(signatureHex);
  } catch {
    return { ok: false, reason: 'signature 不是合法 hex' };
  }
  if (sig.length !== 64) return { ok: false, reason: 'signature 长度不是 64 字节' };

  const { publicKey } = await keysFromSecret(secret);
  const msg = concatBytes(utf8(String(timestamp)), rawBody);
  const ok = await crypto.subtle.verify({ name: 'Ed25519' }, publicKey, sig, msg);
  return ok ? { ok: true } : { ok: false, reason: 'Ed25519 验签不通过' };
}

/** 单测用:清掉密钥缓存 */
export function _clearKeyCache() {
  keyCache.clear();
}
