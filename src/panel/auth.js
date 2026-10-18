import { FIXED } from '../config.js';
import { ensureSchema, one, run } from '../store/db.js';

const enc = new TextEncoder();
export const COOKIE = 'np_session';

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(s) {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(pad + '='.repeat((4 - (pad.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function eqStr(a, b) {
  return sameBytes(enc.encode(String(a)), enc.encode(String(b)));
}

async function hmacKey(env) {
  const material = `${env?.ADMIN_USER || ''}|${env?.ADMIN_PASS || ''}|nomo-session`;
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(material));
  return crypto.subtle.importKey('raw', digest, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

export async function issue(env) {
  const exp = Date.now() + FIXED.sessionDays * 86400000;
  const payload = `${env.ADMIN_USER}.${exp}`;
  const key = await hmacKey(env);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(payload)));
  return `${b64url(enc.encode(payload))}.${b64url(sig)}`;
}

export async function verify(env, token) {
  if (!token || !token.includes('.')) return false;
  const [p, s] = token.split('.');
  let payload = '';
  try {
    payload = new TextDecoder().decode(unb64url(p));
  } catch {
    return false;
  }
  const [user, exp] = payload.split('.');
  if (user !== env.ADMIN_USER) return false;
  if (!exp || Number(exp) < Date.now()) return false;
  const key = await hmacKey(env);
  const expect = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(payload)));
  try {
    return sameBytes(expect, unb64url(s));
  } catch {
    return false;
  }
}

export function readCookie(request, name = COOKIE) {
  const raw = request.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return '';
}

export function cookieHeader(token, maxAge) {
  return `${COOKIE}=${token}; Path=/administrator; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

export function clearCookieHeader() {
  return `${COOKIE}=; Path=/administrator; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export async function isAuthed(request, env) {
  return verify(env, readCookie(request));
}

export async function lockedFor(env, ip) {
  if (!env?.DB) return 0;
  await ensureSchema(env.DB);
  const r = await one(env.DB, 'SELECT fails, until FROM logins WHERE ip = ?', ip);
  if (!r) return 0;
  const until = Number(r.until || 0);
  return until > Date.now() ? until - Date.now() : 0;
}

export async function noteFail(env, ip) {
  if (!env?.DB) return { fails: 1, until: 0 };
  await ensureSchema(env.DB);
  const r = await one(env.DB, 'SELECT fails FROM logins WHERE ip = ?', ip);
  const fails = Number(r?.fails || 0) + 1;
  const until = fails >= FIXED.loginMaxFails ? Date.now() + FIXED.loginLockMs : 0;
  await run(env.DB,
    `INSERT INTO logins (ip, fails, until, ts) VALUES (?, ?, ?, ?)
     ON CONFLICT(ip) DO UPDATE SET fails = ?, until = ?, ts = ?`,
    ip, fails, until, Date.now(), fails, until, Date.now());
  return { fails, until };
}

export async function clearFail(env, ip) {
  try {
    await run(env.DB, 'DELETE FROM logins WHERE ip = ?', ip);
  } catch {
    /* ignore */
  }
}

export function checkCredentials(env, user, pass) {
  const u = String(env?.ADMIN_USER || '');
  const p = String(env?.ADMIN_PASS || '');
  if (!u || !p) return false;
  return eqStr(user, u) & eqStr(pass, p);
}

export function sameOrigin(request) {
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}
