import { bytesToHex, concatBytes, hexToBytes, utf8 } from '../util/bytes.js';

const PKCS8_PREFIX = hexToBytes('302e020100300506032b657004220420');

const keyCache = new Map();

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

export async function keysFromSecret(secret) {
  const cacheKey = String(secret);
  if (keyCache.has(cacheKey)) return keyCache.get(cacheKey);

  const seed = seedFromSecret(secret);
  const pkcs8 = concatBytes(PKCS8_PREFIX, seed);
  const privateKey = await crypto.subtle.importKey(
    'pkcs8', pkcs8, { name: 'Ed25519' }, true, ['sign'],
  );
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

export async function signValidation(secret, eventTs, plainToken) {
  const { privateKey } = await keysFromSecret(secret);
  const msg = utf8(String(eventTs) + String(plainToken));
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, msg);
  return bytesToHex(new Uint8Array(sig));
}

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

export function _clearKeyCache() {
  keyCache.clear();
}
