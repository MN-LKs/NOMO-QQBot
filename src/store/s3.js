// S3 兼容对象存储客户端:Filebase、Upstash、R2 的 S3 API、MinIO 等都能用。
// 纯 WebCrypto 实现 AWS Signature V4,不依赖任何第三方库。

const enc = new TextEncoder();

function hex(bytes) {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(data) {
  const bytes = typeof data === 'string' ? enc.encode(data) : data;
  return hex(await crypto.subtle.digest('SHA-256', bytes));
}

async function hmacSha256(key, data) {
  const raw = typeof key === 'string' ? enc.encode(key) : key;
  const k = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return await crypto.subtle.sign('HMAC', k, typeof data === 'string' ? enc.encode(data) : data);
}

// RFC3986:除 A-Za-z0-9-_.~ 之外全部百分号编码,斜杠按需保留
export function uriEncode(s, keepSlash = false) {
  let out = '';
  for (const ch of String(s)) {
    if (/[A-Za-z0-9\-_.~]/.test(ch)) out += ch;
    else if (ch === '/' && keepSlash) out += '/';
    else for (const b of enc.encode(ch)) out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

export async function signingKey(secretKey, date, region, service = 's3') {
  const kDate = await hmacSha256('AWS4' + secretKey, date);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  return await hmacSha256(kService, 'aws4_request');
}

/**
 * 计算 SigV4 签名。headers 需要是「小写名 -> 值」的普通对象(host / x-amz-date 等),
 * canonicalQuery 是已排序并编码过的查询串,可以为空串。
 */
export async function computeSignature({ method, canonicalUri, canonicalQuery = '', headers, payloadHash, accessKey, secretKey, region, amzDate, service = 's3' }) {
  const names = Object.keys(headers).map((k) => k.toLowerCase()).sort();
  const canonicalHeaders = names.map((k) => `${k}:${String(headers[k]).trim()}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${amzDate.slice(0, 8)}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest)].join('\n');
  const key = await signingKey(secretKey, amzDate.slice(0, 8), region, service);
  const signature = hex(await hmacSha256(key, stringToSign));
  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { authorization, canonicalRequest, stringToSign, signature };
}

function decodeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
}

function xmlText(xml, tag) {
  const m = String(xml).match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? decodeXml(m[1]) : '';
}

export class S3Client {
  constructor(cfg = {}) {
    let ep = String(cfg.endpoint || '').trim().replace(/\/+$/, '');
    if (ep && !/^https?:\/\//.test(ep)) ep = 'https://' + ep;
    this.endpoint = ep;
    this.bucket = String(cfg.bucket || '').trim();
    this.region = String(cfg.region || 'auto').trim() || 'auto';
    this.accessKey = String(cfg.accessKey || '').trim();
    this.secretKey = String(cfg.secretKey || '').trim();
    this.pathStyle = cfg.pathStyle !== false;
  }

  get ready() {
    return !!(this.endpoint && this.bucket && this.accessKey && this.secretKey);
  }

  objectUrl(key, search) {
    const u = new URL(this.endpoint);
    const seg = key ? String(key).split('/').map((x) => uriEncode(x)).join('/') : '';
    if (this.pathStyle) {
      u.pathname = `/${uriEncode(this.bucket)}${seg ? '/' + seg : ''}`;
    } else {
      u.host = `${this.bucket}.${u.host}`;
      u.pathname = seg ? `/${seg}` : '/';
    }
    if (search) u.search = search;
    return u;
  }

  async request(method, key, { body = null, contentType = '', query = {} } = {}) {
    if (!this.ready) throw new Error('S3 配置不完整(需要 endpoint / bucket / 密钥)');
    const qpairs = Object.entries(query)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => [uriEncode(k), uriEncode(String(v))])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const canonicalQuery = qpairs.map(([k, v]) => `${k}=${v}`).join('&');
    const u = this.objectUrl(key, canonicalQuery || undefined);
    const canonicalUri = u.pathname || '/';
    const payload = body || new Uint8Array(0);
    const payloadHash = await sha256Hex(payload);
    const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const signedHeaderObj = {
      host: u.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...(contentType ? { 'content-type': contentType } : {}),
    };
    const signed = await computeSignature({
      method, canonicalUri, canonicalQuery, headers: signedHeaderObj, payloadHash,
      accessKey: this.accessKey, secretKey: this.secretKey, region: this.region, amzDate,
    });
    const headers = {
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      authorization: signed.authorization,
      ...(contentType ? { 'content-type': contentType } : {}),
    };
    const init = { method, headers };
    if (method !== 'GET' && method !== 'HEAD') init.body = payload;
    return await fetch(u.toString(), init);
  }

  async errorFrom(res, what) {
    let msg = '';
    try {
      const text = await res.text();
      msg = xmlText(text, 'Message') || text.slice(0, 200);
    } catch {
      msg = '';
    }
    return new Error(`${what}失败 HTTP ${res.status}${msg ? `: ${msg}` : ''}`);
  }

  async put(key, bytes, contentType = '') {
    const res = await this.request('PUT', key, { body: bytes, contentType: contentType || 'application/octet-stream' });
    if (!res.ok) throw await this.errorFrom(res, `上传 ${key}`);
    return { size: bytes.byteLength ?? bytes.length };
  }

  async get(key) {
    const res = await this.request('GET', key);
    if (res.status === 404) return null;
    if (!res.ok) throw await this.errorFrom(res, `读取 ${key}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async head(key) {
    const res = await this.request('HEAD', key);
    if (res.status === 404) return null;
    if (!res.ok) throw await this.errorFrom(res, `查询 ${key}`);
    const len = Number(res.headers.get('content-length'));
    return Number.isFinite(len) ? len : 0;
  }

  async delete(key) {
    const res = await this.request('DELETE', key);
    if (!res.ok && res.status !== 404) throw await this.errorFrom(res, `删除 ${key}`);
  }

  async list({ prefix = '', cursor = '', limit = 1000 } = {}) {
    const res = await this.request('GET', '', {
      query: { 'list-type': '2', prefix, 'max-keys': String(limit), 'continuation-token': cursor },
    });
    if (!res.ok) throw await this.errorFrom(res, '列出文件');
    const xml = await res.text();
    const keys = [];
    const blocks = String(xml).match(/<Contents>[\s\S]*?<\/Contents>/g) || [];
    for (const b of blocks) {
      const name = xmlText(b, 'Key');
      if (name) keys.push({ name, size: Number(xmlText(b, 'Size')) || 0 });
    }
    const truncated = /<IsTruncated>true<\/IsTruncated>/i.test(xml);
    const next = truncated ? xmlText(xml, 'NextContinuationToken') : '';
    return { keys, cursor: next || null, complete: !truncated };
  }

  async test() {
    if (!this.ready) return { ok: false, error: '配置不完整:endpoint / bucket / AccessKey / SecretKey 都要填' };
    try {
      const r = await this.list({ limit: 1 });
      return { ok: true, note: `连接成功,桶里至少有 ${r.keys.length} 个对象可读` };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  }
}
