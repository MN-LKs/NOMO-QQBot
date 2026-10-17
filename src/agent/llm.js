const UA = 'NOMO-QQBot/4.0';
const REASONING_HEAD_MAX = 1500;

export class UpstreamError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status ?? null;
  }
}

export const RETRY_NUDGE = '系统提示:你上一条回复没有产出任何可用内容。'
  + '现在请立刻用简体中文给出最终答案,不要做额外的推理或自我检查,直接输出答案本身。';

function text(v) {
  return typeof v === 'string' ? v : '';
}

function normaliseToolCalls(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const tc of raw) {
    const fn = tc?.function || {};
    let name = String(fn.name || '');
    let args = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {});
    const unwrapped = unwrapEnvelope(name, args);
    name = unwrapped.name;
    args = unwrapped.args;
    if (!name) continue;
    out.push({
      id: String(tc?.id || `call_${Math.random().toString(36).slice(2, 10)}`),
      type: 'function',
      function: { name, arguments: args || '{}' },
    });
  }
  return out;
}

function unwrapEnvelope(name, args) {
  if (name && !/^[\u200b\s]*$/.test(name)) return { name, args };
  try {
    const o = JSON.parse(args);
    const inner = String(o?.name || o?.tool || o?.function || '');
    if (inner) {
      const innerArgs = o?.arguments ?? o?.parameters ?? {};
      return { name: inner, args: typeof innerArgs === 'string' ? innerArgs : JSON.stringify(innerArgs) };
    }
  } catch {
    return { name, args };
  }
  return { name, args };
}

export function parseCompletion(json) {
  const ch = Array.isArray(json?.choices) ? json.choices[0] : null;
  const msg = ch?.message || {};
  const reasoning = text(msg.reasoning_content) || text(msg.reasoning) || text(msg.reasoning_text);
  return {
    content: text(msg.content),
    reasoningHead: reasoning.slice(0, REASONING_HEAD_MAX),
    reasoningLen: reasoning.length,
    toolCalls: normaliseToolCalls(msg.tool_calls),
    finishReason: ch?.finish_reason ?? null,
    usage: json?.usage ?? null,
  };
}

export function isBlank(r) {
  return !String(r?.content || '').trim() && !(r?.toolCalls || []).length;
}

export async function chatOnce(cfg, messages, tools, opts = {}) {
  const effort = opts.effort ?? cfg.reasoningEffort;
  // 0 表示不限制:一直等上游,直到它返回内容或者报错断开。
  const rawTimeout = opts.timeoutMs ?? cfg.llmTimeoutMs;
  const timeoutMs = Number(rawTimeout) > 0 ? Math.max(5000, Number(rawTimeout)) : 0;
  const started = Date.now();

  const body = { model: cfg.llmModel, messages, stream: false };
  if (effort && effort !== 'off' && effort !== 'default') body.reasoning_effort = effort;
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  const ctrl = new AbortController();
  let timer = null;
  if (timeoutMs > 0) timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);

  try {
    const res = await fetch(`${cfg.llmBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${cfg.llmApiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': UA,
        'Accept': 'application/json',
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });

    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new UpstreamError(`上游 HTTP ${res.status}: ${t.slice(0, 300)}`, res.status);
    }

    const raw = await res.text();
    let json;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new UpstreamError(`上游返回的不是 JSON: ${raw.slice(0, 200)}`, res.status);
    }
    if (json?.error) {
      throw new UpstreamError(`上游返回错误: ${JSON.stringify(json.error).slice(0, 300)}`, res.status);
    }

    return { ...parseCompletion(json), elapsedMs: Date.now() - started, aborted: false, error: null };
  } catch (e) {
    if (e?.name === 'AbortError' || /timeout/i.test(String(e?.message || ''))) {
      return {
        content: '', reasoningHead: '', reasoningLen: 0, toolCalls: [], finishReason: null,
        usage: null, elapsedMs: Date.now() - started, aborted: true,
        error: timeoutMs > 0 ? `超时(${timeoutMs}ms)` : '请求被取消',
      };
    }
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function chatWithFallback(cfg, messages, tools, opts = {}) {
  const ladder = [opts.effort ?? cfg.reasoningEffort, cfg.fallbackEffort, 'minimal']
    .filter((e, i, a) => e && a.indexOf(e) === i);

  let convo = messages;
  let last = null;
  const attemptLog = [];

  for (let i = 0; i < ladder.length; i++) {
    let r;
    try {
      r = await chatOnce(cfg, convo, tools, { ...opts, effort: ladder[i] });
    } catch (e) {
      attemptLog.push({ effort: ladder[i], error: String(e?.message || e) });
      last = {
        content: '', reasoningHead: '', reasoningLen: 0, toolCalls: [], finishReason: null,
        usage: null, aborted: false, elapsedMs: 0, error: String(e?.message || e),
      };
      continue;
    }

    attemptLog.push({ effort: ladder[i], elapsedMs: r.elapsedMs, contentLen: r.content.length, tools: r.toolCalls.length });

    if (!isBlank(r)) {
      return {
        ...r,
        attempts: i + 1,
        downgradedFrom: i > 0 ? ladder[0] : null,
        downgradedTo: i > 0 ? ladder[i] : null,
        attemptLog,
      };
    }

    last = r;
    convo = [...convo, { role: 'user', content: RETRY_NUDGE }];
  }

  return { ...last, attempts: ladder.length, downgradedFrom: ladder[0], downgradedTo: null, attemptLog };
}
