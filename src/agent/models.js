/**
 * 万能模型层。
 *
 * 主对话模型(LLM)之外,机器人还需要 OCR / ASR / TTS / 图像生成 / 摘要压缩
 * 这几类专用模型。它们使用的是同一批协议,只是参数和返回形态不同,
 * 所以这里做成一个统一的「模型调用层」:
 *
 *   models: {
 *     ocr:      { enabled, provider, baseUrl, apiKey, model, prompt, protocol },
 *     asr:      { ... },
 *     tts:      { ... },
 *     imageGen: { ... },
 *     compress: { ... },
 *   }
 *
 * provider 只用于在面板上分组展示,真正决定请求形态的是 protocol:
 *   chat      -> POST {base}/chat/completions        (OpenAI 兼容,最常用)
 *   responses -> POST {base}/responses               (OpenAI Responses API)
 *   google    -> POST {base}/models/{model}:generateContent
 *   claude    -> POST {base}/v1/messages            (Anthropic 兼容)
 *
 * 每个模型都可以单独测试(面板「模型」页),失败的模型不会拖垮主对话:
 * OCR 挂了就退回原生视觉或只带 [图片] 标签,TTS 挂了就只发文字。
 */

const UA = 'NOMO-QQBot/4.0';
const DEFAULT_TIMEOUT = 60000;

/** 面板支持的五类模型。key 同时是 settings.models 下的字段名 */
export const MODEL_KINDS = ['ocr', 'asr', 'tts', 'imageGen', 'compress'];

export const KIND_META = {
  ocr: { label: '图片识别 OCR', icon: '🔍', desc: '把图片里的文字提取成文本,可用后主模型就能"读懂"图片' },
  asr: { label: '语音识别 ASR', icon: '🎙️', desc: '把语音消息转成文字,再接进主模型对话' },
  tts: { label: '语音合成 TTS', icon: '🔊', desc: '把回复念出来,通过 QQ 语音消息发送' },
  imageGen: { label: '图像生成', icon: '🎨', desc: '按描述生成图片,通过 QQ 图片消息发送' },
  compress: { label: '摘要压缩', icon: '🗜️', desc: '把过长的对话历史压成摘要,节省上下文' },
};

export const PROTOCOLS = ['chat', 'responses', 'google', 'claude'];

export const DEFAULT_MODEL = {
  enabled: false,
  baseUrl: '',
  apiKey: '',
  model: '',
  protocol: 'chat',
  prompt: '',
  // 个别模型需要传温度等参数,给一个自由填的兜底
  extra: {},
};

/** 深合并单个模型配置,缺字段补默认值,脏字段清掉 */
export function normaliseModel(raw) {
  const m = raw && typeof raw === 'object' ? raw : {};
  const protocol = PROTOCOLS.includes(m.protocol) ? m.protocol : 'chat';
  return {
    enabled: m.enabled === true,
    baseUrl: String(m.baseUrl || '').trim().replace(/\/+$/, ''),
    apiKey: String(m.apiKey || '').trim(),
    model: String(m.model || '').trim(),
    protocol,
    prompt: String(m.prompt || ''),
    extra: m.extra && typeof m.extra === 'object' && !Array.isArray(m.extra) ? m.extra : {},
  };
}

export function normaliseModels(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const k of MODEL_KINDS) out[k] = normaliseModel(src[k]);
  return out;
}

/** 判断一个模型配置是否真的能调(地址和模型名都填了) */
export function modelReady(m) {
  return !!m && m.enabled === true && !!m.baseUrl && !!m.model;
}

function timeoutOf(m) {
  const n = Number(m?.extra?.timeoutMs);
  return Number.isFinite(n) && n > 0 ? Math.max(1000, n) : DEFAULT_TIMEOUT;
}

function trimSlash(s) {
  return String(s || '').replace(/\/+$/, '');
}

// 用户可能把完整 /chat/completions 或 /v1/messages 粘进来,统一截掉
function baseOf(m) {
  let b = trimSlash(m.baseUrl);
  b = b.replace(/\/(chat\/completions|messages|responses)$/i, '');
  return b;
}

async function readError(res) {
  const t = await res.text().catch(() => '');
  return `HTTP ${res.status}: ${String(t).slice(0, 300)}`;
}

/* ------------------------------------------------------------------ *
 * 四种协议的请求构造与响应解析
 * ------------------------------------------------------------------ */

function buildChatRequest(m, messages) {
  const body = { model: m.model, messages, stream: false };
  if (m.prompt) body.messages = [{ role: 'system', content: m.prompt }, ...messages];
  return { url: `${baseOf(m)}/chat/completions`, body };
}

function buildResponsesRequest(m, input) {
  const body = { model: m.model, input, stream: false };
  if (m.prompt) body.instructions = m.prompt;
  return { url: `${baseOf(m)}/responses`, body };
}

function buildGoogleRequest(m, contents) {
  const body = { contents };
  if (m.prompt) body.systemInstruction = { parts: [{ text: m.prompt }] };
  return { url: `${baseOf(m)}/models/${encodeURIComponent(m.model)}:generateContent`, body };
}

function buildClaudeRequest(m, messages) {
  const sys = m.prompt || '';
  const rest = sys ? messages.filter((x) => x.role !== 'system') : messages;
  const body = {
    model: m.model,
    max_tokens: Number(m.extra?.maxTokens) || 4096,
    messages: rest.map((x) => ({ role: x.role === 'system' ? 'user' : x.role, content: x.content })),
  };
  if (sys) body.system = sys;
  return { url: `${baseOf(m)}/v1/messages`, body };
}

/** 四种协议 -> 统一成 { text } */
export function parseByProtocol(protocol, json) {
  if (protocol === 'chat') {
    const msg = json?.choices?.[0]?.message || {};
    if (typeof msg.content === 'string') return { text: msg.content };
    if (Array.isArray(msg.content)) {
      return { text: msg.content.map((c) => c?.text || '').join('') };
    }
    return { text: '' };
  }
  if (protocol === 'responses') {
    if (typeof json?.output_text === 'string') return { text: json.output_text };
    const parts = [];
    for (const item of json?.output || []) {
      for (const c of item?.content || []) if (c?.text) parts.push(c.text);
    }
    return { text: parts.join('') };
  }
  if (protocol === 'google') {
    const parts = [];
    for (const c of json?.candidates?.[0]?.content?.parts || []) if (c?.text) parts.push(c.text);
    return { text: parts.join('') };
  }
  if (protocol === 'claude') {
    if (typeof json?.content === 'string') return { text: json.content };
    if (Array.isArray(json?.content)) {
      return { text: json.content.map((c) => c?.text || '').join('') };
    }
    return { text: '' };
  }
  return { text: '' };
}

/**
 * 调用一个「文本进文本出」的模型。messages 走 OpenAI 风格,
 * 内部自动按 protocol 转换;返回 { text, raw }。
 */
export async function callTextModel(m, messages, opts = {}) {
  if (!modelReady(m)) throw new Error('模型未配置或未启用');
  const timeoutMs = Number(opts.timeoutMs) || timeoutOf(m);
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': UA,
    'Accept': 'application/json',
  };
  if (m.apiKey) {
    if (m.protocol === 'claude') headers['x-api-key'] = m.apiKey;
    else headers['Authorization'] = `Bearer ${m.apiKey}`;
  }
  if (m.protocol === 'claude' && m.extra?.anthropicVersion) {
    headers['anthropic-version'] = String(m.extra.anthropicVersion);
  } else if (m.protocol === 'claude') {
    headers['anthropic-version'] = '2023-06-01';
  }
  Object.assign(headers, m.extra?.headers && typeof m.extra.headers === 'object' ? m.extra.headers : {});

  let url;
  let body;
  if (m.protocol === 'responses') {
    const input = messages.map((x) => ({
      role: x.role,
      content: typeof x.content === 'string' ? x.content : JSON.stringify(x.content),
    }));
    ({ url, body } = buildResponsesRequest(m, input));
  } else if (m.protocol === 'google') {
    const contents = messages.map((x) => ({
      role: x.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: typeof x.content === 'string' ? x.content : JSON.stringify(x.content) }],
    }));
    ({ url, body } = buildGoogleRequest(m, contents));
  } else if (m.protocol === 'claude') {
    ({ url, body } = buildClaudeRequest(m, messages));
  } else {
    ({ url, body } = buildChatRequest(m, messages));
  }
  if (m.extra?.body && typeof m.extra.body === 'object') Object.assign(body, m.extra.body);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(await readError(res));
    const raw = await res.text();
    let json;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new Error(`返回的不是 JSON: ${raw.slice(0, 200)}`);
    }
    if (json?.error) throw new Error(`接口报错: ${JSON.stringify(json.error).slice(0, 300)}`);
    const parsed = parseByProtocol(m.protocol, json);
    if (opts.raw) return { ...parsed, raw };
    return parsed;
  } catch (e) {
    if (e?.name === 'AbortError' || /timeout/i.test(String(e?.message || ''))) {
      throw new Error(`模型请求超时(${timeoutMs}ms)`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ *
 * 五类模型的专属入口
 * ------------------------------------------------------------------ */

/** OCR:图 -> 文。imageUrl 支持 http(s) 或 data URL */
export async function ocrImage(m, imageUrl, opts = {}) {
  const prompt = opts.prompt
    || m.prompt
    || '请把这张图片里的文字原样提取出来,保持原有换行;没有文字就回答「无文字」。不要额外解释。';
  const res = await callTextModel(m, [{
    role: 'user',
    content: [
      { type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: imageUrl } },
    ],
  }], { ...opts, raw: true });
  return res;
}

/** OCR:从二进制图片数据走一遍 */
export async function ocrBytes(m, bytes, contentType, opts = {}) {
  const url = bytesToDataUrl(bytes, contentType);
  return ocrImage(m, url, opts);
}

export function bytesToDataUrl(bytes, contentType = 'image/png') {
  let s = '';
  const chunk = 0x8000;
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  for (let i = 0; i < u8.length; i += chunk) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
  }
  return `data:${contentType};base64,${btoa(s)}`;
}

/**
 * ASR:音频 -> 文。要求模型协议为 chat 且支持 audio input(OpenAI 兼容),
 * 传 { type: 'input_audio', input_audio: { data, format } }。
 * 不支持的接口会报错,由调用方降级成「转不了,请发文字」。
 */
export async function asrAudio(m, bytes, format = 'wav', opts = {}) {
  if (m.protocol !== 'chat') throw new Error('语音识别目前只支持 OpenAI 兼容(chat)协议的接口');
  const prompt = opts.prompt || m.prompt || '请把这段语音转成文字,只输出文字本身。';
  const b64 = bytesToDataUrl(bytes, `audio/${format}`).split(',')[1];
  const res = await callTextModel(m, [{
    role: 'user',
    content: [
      { type: 'text', text: prompt },
      { type: 'input_audio', input_audio: { data: b64, format } },
    ],
  }], { ...opts, raw: true });
  return res;
}

/**
 * TTS:文字 -> 音频二进制。三种常见形态都试:
 *   1. 直接返回 audio/mpeg 等二进制(POST {base}/audio/speech)
 *   2. 返回 JSON,里面带 b64 / audio / url 字段
 *   3. chat 协议让它返回 base64(用 prompt 指定)
 */
export async function ttsSpeech(m, text, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) || timeoutOf(m);
  const path = String(m.extra?.ttsPath || '/audio/speech');
  const url = m.protocol === 'chat' && m.extra?.ttsViaChat
    ? `${baseOf(m)}/chat/completions`
    : `${baseOf(m)}${path.startsWith('/') ? path : '/' + path}`;
  const voice = String(opts.voice || m.extra?.voice || 'alloy');
  const headers = { 'User-Agent': UA, Accept: '*/*' };
  if (m.apiKey) headers['Authorization'] = `Bearer ${m.apiKey}`;
  Object.assign(headers, m.extra?.headers && typeof m.extra.headers === 'object' ? m.extra.headers : {});
  const body = { model: m.model, voice, input: text };
  if (m.extra?.responseFormat) body.response_format = String(m.extra.responseFormat);
  if (m.extra?.speed) body.speed = Number(m.extra.speed);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`TTS HTTP ${res.status}: ${t.slice(0, 300)}`);
    }
    const ct = String(res.headers.get('content-type') || '').toLowerCase();
    if (ct.startsWith('application/json') || ct.startsWith('text/')) {
      const json = await res.json().catch(() => ({}));
      const b64 = json?.audio || json?.audioContent || json?.data || json?.b64 || json?.audio_base64;
      if (typeof b64 === 'string' && b64.length > 32) {
        return { bytes: fromBase64(b64), contentType: 'audio/mpeg', raw: json };
      }
      if (typeof json?.url === 'string' && json.url) {
        const r2 = await fetch(json.url, { headers: { 'User-Agent': UA } });
        const buf = new Uint8Array(await r2.arrayBuffer());
        return { bytes: buf, contentType: r2.headers.get('content-type') || 'audio/mpeg', url: json.url };
      }
      throw new Error('TTS 接口返回的 JSON 里没有音频字段(audio/url)');
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    if (!buf.length) throw new Error('TTS 接口返回了空音频');
    return { bytes: buf, contentType: ct.split(';')[0] || 'audio/mpeg' };
  } catch (e) {
    if (e?.name === 'AbortError' || /timeout/i.test(String(e?.message || ''))) {
      throw new Error(`TTS 请求超时(${timeoutMs}ms)`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 图像生成。两种常见形态:
 *   1. POST {base}/images/generations,响应里 b64_json 或 url
 *   2. chat 协议下模型直接吐 markdown 图片链接
 */
export async function generateImage(m, prompt, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) || timeoutOf(m);
  const path = String(m.extra?.imagePath || '/images/generations');
  const url = `${baseOf(m)}${path.startsWith('/') ? path : '/' + path}`;
  const size = String(opts.size || m.extra?.size || '1024x1024');
  const headers = { 'Content-Type': 'application/json', 'User-Agent': UA, Accept: 'application/json' };
  if (m.apiKey) headers['Authorization'] = `Bearer ${m.apiKey}`;
  Object.assign(headers, m.extra?.headers && typeof m.extra.headers === 'object' ? m.extra.headers : {});
  const body = { model: m.model, prompt, n: 1, size, response_format: m.extra?.responseFormat || 'b64_json' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(await readError(res));
    const json = await res.json().catch(() => ({}));
    const first = json?.data?.[0] || {};
    if (typeof first.b64_json === 'string' && first.b64_json.length > 32) {
      return { bytes: fromBase64(first.b64_json), contentType: 'image/png', raw: json };
    }
    if (typeof first.url === 'string' && first.url) {
      const r2 = await fetch(first.url, { headers: { 'User-Agent': UA } });
      const buf = new Uint8Array(await r2.arrayBuffer());
      return { bytes: buf, contentType: r2.headers.get('content-type') || 'image/png', url: first.url };
    }
    if (typeof json?.image === 'string' && json.image.length > 32) {
      return { bytes: fromBase64(json.image), contentType: 'image/png', raw: json };
    }
    throw new Error('图像接口返回里没有图片(b64_json / url)');
  } catch (e) {
    if (e?.name === 'AbortError' || /timeout/i.test(String(e?.message || ''))) {
      throw new Error(`图像生成超时(${timeoutMs}ms)`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** 摘要压缩:长文本进,短摘要出 */
export async function compressText(m, text, opts = {}) {
  const prompt = opts.prompt
    || m.prompt
    || '请把下面的对话历史压缩成一段不超过 800 字的摘要,保留对后续对话有用的事实、'
    + '用户偏好、待办事项和结论,丢掉闲聊和重复内容。只输出摘要本身。';
  const maxChars = Number(opts.maxChars) || 20000;
  return callTextModel(m, [
    { role: 'system', content: prompt },
    { role: 'user', content: String(text || '').slice(0, maxChars) },
  ], opts);
}

/* ------------------------------------------------------------------ *
 * base64 工具
 * ------------------------------------------------------------------ */

export function fromBase64(s) {
  const bin = atob(String(s || ''));
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

export function toBase64(bytes) {
  let s = '';
  const chunk = 0x8000;
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  for (let i = 0; i < u8.length; i += chunk) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
  }
  return btoa(s);
}

/** 按 format 猜一个 QQ 能接受的音频 content-type */
export function audioContentType(format) {
  const f = String(format || '').toLowerCase();
  if (f === 'mp3' || f === 'mpeg') return 'audio/mpeg';
  if (f === 'amr') return 'audio/amr';
  if (f === 'wav' || f === 'pcm') return 'audio/wav';
  if (f === 'silk') return 'audio/silk';
  return 'audio/mpeg';
}
