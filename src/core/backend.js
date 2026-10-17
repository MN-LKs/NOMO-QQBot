// 后端沙盒执行器:预制后端JS模块、站点自定义后端都从这里跑。
// 依赖 jsmini 解释器(Workers 禁 eval,解释器是唯一能在免费套餐上跑动态代码的路)。

import { runProgram } from './jsmini-run.js';

const PRIVATE_HOST_RE = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[::1\])/;

function assertSafeUrl(raw) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    throw new Error('fetch 的网址格式不对');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('fetch 只支持 http/https');
  const host = u.hostname.toLowerCase();
  if (PRIVATE_HOST_RE.test(host) || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('不允许访问内网地址');
  }
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) throw new Error('不允许访问内网地址');
  return u;
}

// 沙盒里的 fetch:禁内网 + 超时 + 把 Response 包装成「纯对象 + 方法」,
// 解释器只认识普通对象上的方法。
export async function sandboxFetch(url, init = {}, timeoutMs = 15000) {
  const u = assertSafeUrl(url);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1000, Math.min(60000, timeoutMs)));
  try {
    const res = await fetch(u.toString(), { ...init, signal: ctrl.signal, redirect: 'follow' });
    const headers = {};
    try {
      res.headers.forEach((v, k) => {
        headers[k] = v;
      });
    } catch {
      /* ignore */
    }
    return {
      ok: res.ok,
      status: res.status,
      headers,
      text: async () => await res.text(),
      json: async () => {
        const t = await res.text();
        try {
          return JSON.parse(t);
        } catch {
          throw new Error(`返回的不是 JSON:${t.slice(0, 120)}`);
        }
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 执行一段后端 JS。
 * @param {string} code 源码(顶层直接写语句,用 return 返回结果;也可以定义 main(ctx))
 * @param {object} ctxData 注入到 ctx 的内容
 * @returns {Promise<{ok:boolean, value?:any, error?:string, logs:string[]}>}
 */
export async function execBackend(code, ctxData, { timeoutMs = 5000, maxSteps = 400000 } = {}) {
  const logs = [];
  const ctx = {
    ...ctxData,
    log: (...xs) => {
      if (logs.length < 100) {
        logs.push(xs.map((x) => (typeof x === 'string' ? x : safeJson(x))).join(' '));
      }
    },
  };
  try {
    const { value } = await runProgram(String(code || ''), {
      globals: { ctx, console: ctx },
      timeoutMs,
      maxSteps,
    });
    return { ok: true, value, logs };
  } catch (e) {
    return { ok: false, error: String(e?.message || e), logs };
  }
}

function safeJson(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// 后端返回值 -> HTTP 响应形状
export function normalizeBackendResult(value) {
  if (value === undefined || value === null) {
    return { status: 200, contentType: 'application/json; charset=utf-8', body: 'null', headers: {} };
  }
  if (typeof value === 'string') {
    return { status: 200, contentType: 'text/plain; charset=utf-8', body: value, headers: {} };
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    const hasShape = 'status' in value || 'body' in value || 'contentType' in value || 'headers' in value;
    if (hasShape) {
      const headers = value.headers && typeof value.headers === 'object' ? value.headers : {};
      const out = {};
      for (const [k, v] of Object.entries(headers)) out[String(k)] = String(v);
      return {
        status: Number(value.status) || 200,
        contentType: String(value.contentType || 'application/json; charset=utf-8'),
        body: typeof value.body === 'string' ? value.body : safeJson(value.body ?? null),
        headers: out,
      };
    }
  }
  return { status: 200, contentType: 'application/json; charset=utf-8', body: safeJson(value), headers: {} };
}

// Agent 工具结果:后端模块的返回值 -> 可读文本
export function moduleResultText(r) {
  const parts = [];
  if (!r.ok) {
    parts.push(`模块执行失败:${r.error}`);
  } else if (r.value === undefined || r.value === null) {
    parts.push('(模块执行完成,没有返回值)');
  } else if (typeof r.value === 'string') {
    parts.push(r.value);
  } else {
    parts.push(safeJson(r.value));
  }
  if (r.logs.length) parts.push(`模块日志:\n${r.logs.join('\n')}`);
  return parts.join('\n').slice(0, 2600);
}
