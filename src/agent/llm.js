// 上游大模型客户端。
//
// 为什么必须用流式(stream: true)?
// 实测这个中转站的非流式请求在 ~66 秒会被上游 504 掐断,
// 而 reasoning_effort=max 的难题轻松跑到 60~120 秒。流式不会。
//
// 为什么解析要写得这么抠?
// max 档思考很容易吐出 2.5 MB 的 SSE(16000+ 个分片),
// 免费套餐 CPU 只有 10 ms/请求,所以:纯思考分片一律不做 JSON.parse。

const UA = 'QQBot-NB-API/1.0 (+cloudflare-workers)';
const REASONING_HEAD_MAX = 1500; // 日志里只留思考的前 1.5K 字

export function newStreamState() {
  return {
    buf: '',
    content: '',
    reasoningHead: '',
    reasoningLen: 0,
    toolCalls: [],
    finishReason: null,
    usage: null,
    done: false,
    events: 0,
  };
}

/**
 * 定位 `"key"` 后面那个值的起始位置(容忍 `"key":"v"` 和 `"key": "v"` 两种写法)。
 * 返回 -1 表示没找到。纯字符串扫描,不做 JSON.parse —— 这是省 CPU 的关键。
 */
export function valueStart(line, key) {
  const i = line.indexOf(`"${key}"`);
  if (i < 0) return -1;
  let j = i + key.length + 2;
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  if (line.charCodeAt(j) !== 58) return -1; // ':'
  j++;
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  return j;
}

/** 判断 `"key": "非空字符串"` */
export function hasNonEmptyString(line, key) {
  const j = valueStart(line, key);
  return j >= 0 && line.charCodeAt(j) === 34 && line.charCodeAt(j + 1) !== 34;
}

/** 判断 `"key"` 的值不是 null(用于 usage 这种对象字段) */
export function hasNonNull(line, key) {
  const j = valueStart(line, key);
  return j >= 0 && line.charCodeAt(j) !== 110; // 'n' -> null
}

/**
 * 定位 `"reasoning_content": "..."` 的值区间(处理转义)。
 * 返回 null 表示这一行没有思考内容。只做一次线性扫描,不构造字符串。
 */
export function reasoningSpan(line) {
  const start = valueStart(line, 'reasoning_content');
  if (start < 0) return null;
  if (line.charCodeAt(start) !== 34) return null;
  if (line.charCodeAt(start + 1) === 34) return null; // 空字符串
  let j = start + 1;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if (c === 92) {
      j += 2;
      continue;
    }
    if (c === 34) break;
    j++;
  }
  return { start: start + 1, end: Math.min(j, line.length) };
}

/** 从一行 JSON 里抠出某个字符串字段(只用于日志截取,容忍转义) */
export function extractString(line, key) {
  const start = valueStart(line, key);
  if (start < 0 || line.charCodeAt(start) !== 34) return '';
  let j = start + 1;
  let out = '';
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if (c === 92) {
      const n = line.charCodeAt(j + 1);
      if (n === 110) out += '\n';
      else if (n === 116) out += '\t';
      else if (n === 114) out += '\r';
      else if (n === 34) out += '"';
      else if (n === 92) out += '\\';
      else if (n === 117) {
        out += String.fromCharCode(parseInt(line.slice(j + 2, j + 6), 16) || 63);
        j += 4;
      } else out += String.fromCharCode(n);
      j += 2;
      continue;
    }
    if (c === 34) break;
    out += line[j];
    j++;
  }
  return out;
}

function mergeToolCall(list, tc) {
  const idx = Number.isInteger(tc.index) ? tc.index : list.length;
  let slot = list.find((x) => x.index === idx);
  if (!slot) {
    slot = { index: idx, id: '', type: 'function', name: '', args: '' };
    list.push(slot);
  }
  if (tc.id) slot.id = slot.id || tc.id;
  if (tc.type) slot.type = tc.type;
  const fn = tc.function || {};
  if (fn.name) slot.name = slot.name || fn.name;
  if (typeof fn.arguments === 'string') slot.args += fn.arguments;
  else if (fn.arguments && typeof fn.arguments === 'object') slot.args += JSON.stringify(fn.arguments);
}

function handleLine(st, line) {
  if (!line || line.charCodeAt(0) === 58) return; // 空行 / 注释
  if (!line.startsWith('data:')) return;
  const payload = line.slice(5).trim();
  if (!payload) return;
  if (payload === '[DONE]') {
    st.done = true;
    return;
  }

  st.events++;

  // ---- 快路径:纯思考分片,直接丢掉,不做 JSON.parse ----
  const cNonEmpty = hasNonEmptyString(payload, 'content');
  const fNonEmpty = hasNonEmptyString(payload, 'finish_reason');
  const hasTools = payload.indexOf('"tool_calls"') >= 0;
  const hasUsage = hasNonNull(payload, 'usage');
  const rNonEmpty = hasNonEmptyString(payload, 'reasoning_content');

  if (rNonEmpty && !cNonEmpty && !fNonEmpty && !hasTools && !hasUsage) {
    const span = reasoningSpan(payload);
    if (span) {
      st.reasoningLen += span.end - span.start;
      if (st.reasoningHead.length < REASONING_HEAD_MAX) {
        st.reasoningHead += payload.slice(
          span.start,
          Math.min(span.end, span.start + (REASONING_HEAD_MAX - st.reasoningHead.length)),
        );
      }
    }
    return;
  }

  let obj;
  try {
    obj = JSON.parse(payload);
  } catch {
    return;
  }

  if (obj.usage) st.usage = obj.usage;
  if (obj.error) throw new Error(`上游返回错误: ${JSON.stringify(obj.error).slice(0, 300)}`);

  const choices = obj.choices;
  if (!Array.isArray(choices) || choices.length === 0) return;
  const ch = choices[0];
  const d = ch.delta || ch.message || {};

  if (typeof d.content === 'string' && d.content) st.content += d.content;
  if (typeof d.reasoning_content === 'string' && d.reasoning_content) {
    st.reasoningLen += d.reasoning_content.length;
    if (st.reasoningHead.length < REASONING_HEAD_MAX) {
      st.reasoningHead += d.reasoning_content.slice(0, REASONING_HEAD_MAX - st.reasoningHead.length);
    }
  }
  if (Array.isArray(d.tool_calls)) {
    for (const tc of d.tool_calls) mergeToolCall(st.toolCalls, tc);
  }
  if (ch.finish_reason) st.finishReason = ch.finish_reason;
}

/** 把一段已解码文本喂进解析器(会处理跨分片的半行) */
export function feedSseChunk(st, text) {
  if (!text) return;
  st.buf += text;
  let nl;
  while ((nl = st.buf.indexOf('\n')) >= 0) {
    const line = st.buf.slice(0, nl).replace(/\r$/, '');
    st.buf = st.buf.slice(nl + 1);
    handleLine(st, line);
  }
}

/** 收尾:处理缓冲区里可能残留的最后一行 */
export function flushSse(st) {
  if (st.buf) {
    handleLine(st, st.buf.replace(/\r$/, ''));
    st.buf = '';
  }
}

export function toToolCalls(st) {
  return st.toolCalls
    .slice()
    .sort((a, b) => a.index - b.index)
    .filter((t) => t.name)
    .map((t) => ({
      id: t.id || `call_${Math.random().toString(36).slice(2, 10)}`,
      type: 'function',
      function: { name: t.name, arguments: t.args || '{}' },
    }));
}

/**
 * 发起一次对话请求(流式)。
 * @returns {Promise<{content:string, reasoningHead:string, reasoningLen:number,
 *   toolCalls:Array, finishReason:string|null, usage:object|null,
 *   elapsedMs:number, aborted:boolean}>}
 */
export async function chatStream(cfg, messages, tools, opts = {}) {
  const effort = opts.effort ?? cfg.reasoningEffort;
  const maxTokens = opts.maxTokens ?? cfg.maxTokens;
  const timeoutMs = opts.timeoutMs ?? cfg.llmTimeoutMs;

  const body = {
    model: cfg.llmModel,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  // 默认不限制输出长度:不带 max_tokens 字段,让上游按模型自己的上限来。
  // 只有显式配置了正整数(或调用方指定)才带上,否则长回答会被硬截断。
  if (maxTokens > 0) body.max_tokens = maxTokens;
  if (effort && effort !== 'off' && effort !== 'default') body.reasoning_effort = effort;
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  const st = newStreamState();
  const started = Date.now();
  let aborted = false;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);

  try {
    const res = await fetch(`${cfg.llmBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${cfg.llmApiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': UA,
        'Accept': 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });

    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`上游 HTTP ${res.status}: ${t.slice(0, 300)}`);
    }
    if (!res.body) throw new Error('上游没有返回 body');

    const reader = res.body.getReader();
    const dec = new TextDecoder('utf-8');
    for (;;) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (e) {
        // 超时中断:保留已经拿到的内容
        aborted = true;
        break;
      }
      if (chunk.done) break;
      feedSseChunk(st, dec.decode(chunk.value, { stream: true }));
      if (st.done) {
        try { await reader.cancel(); } catch { /* ignore */ }
        break;
      }
    }
    try { feedSseChunk(st, dec.decode()); } catch { /* ignore */ }
    flushSse(st);
  } catch (e) {
    if (e?.name === 'AbortError' || /timeout/.test(String(e?.message))) {
      aborted = true;
    } else {
      clearTimeout(timer);
      throw e;
    }
  } finally {
    clearTimeout(timer);
  }

  return {
    content: st.content,
    reasoningHead: st.reasoningHead,
    reasoningLen: st.reasoningLen,
    toolCalls: toToolCalls(st),
    finishReason: st.finishReason,
    usage: st.usage,
    events: st.events,
    aborted,
    elapsedMs: Date.now() - started,
  };
}

/**
 * 带降级的一次调用。
 *
 * 这是本项目最关键的「防呆」。
 * 实测 reasoning_effort=max 遇到真正的难题时,会把输出预算全部烧在思考上
 * (completion_thinking_tokens 顶到上限,finish_reason=length,正文一个字没有)。
 * 所以一旦出现下面两种情况,就按阶梯重试,保证用户一定能收到正文:
 *   A. 长度截断 + 正文为空 + 没调工具  -> max 降 low 再降 minimal,并追加「别再想了」的提示
 *   B. 超时被中断 + 什么都没拿到        -> 直接用 minimal 试一次(低档位明显更快)
 */
export const RETRY_NUDGE = '系统提示:你上一条回复的思考过程超出了输出预算,被截断了。'
  + '现在请立刻用简体中文给出最终答案,不要再做任何额外的推理或自我检查,直接输出答案本身。';

export function isBurnt(r) {
  return r.finishReason === 'length' && !r.content.trim() && r.toolCalls.length === 0;
}

export function isBlank(r) {
  return !r.content.trim() && r.toolCalls.length === 0;
}

export async function chatWithFallback(cfg, messages, tools, opts = {}) {
  const first = await chatStream(cfg, messages, tools, opts);
  const burnt = isBurnt(first);
  const timedOutBlank = first.aborted && isBlank(first);
  if (!burnt && !timedOutBlank) return { ...first, attempts: 1 };

  // 超时的重试只做一次,免得把总预算耗光
  const ladder = timedOutBlank
    ? ['minimal']
    : [cfg.fallbackEffort, 'minimal'].filter((e, i, a) => e && a.indexOf(e) === i);

  let last = first;
  for (let i = 0; i < ladder.length; i++) {
    const nudged = [...messages, { role: 'user', content: RETRY_NUDGE }];
    const r = await chatStream(cfg, nudged, tools, { ...opts, effort: ladder[i] });
    if (!isBlank(r)) {
      return { ...r, attempts: i + 2, downgradedFrom: cfg.reasoningEffort, downgradedTo: ladder[i] };
    }
    last = r;
  }
  return { ...last, attempts: ladder.length + 1, downgradedFrom: cfg.reasoningEffort };
}
