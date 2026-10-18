const UA = 'NOMO-QQBot/4.0';

function publicUrl(raw) {
  const u = new URL(String(raw));
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('图片地址协议不支持');
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')
    || host === '[::1]' || host.startsWith('fd') || host.startsWith('fe80')) {
    throw new Error('图片地址不可访问');
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b] = host.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0 || (a === 192 && b === 168)
      || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254) || a >= 224) {
      throw new Error('图片地址不可访问');
    }
  }
  return u;
}

function base64(bytes) {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

export async function imageToDataUrl(url, { timeoutMs = 15000, maxBytes = 4 * 1024 * 1024 } = {}) {
  const u = publicUrl(url);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), Math.max(3000, Number(timeoutMs) || 15000));
  try {
    const res = await fetch(u, { signal: ctl.signal, headers: { 'User-Agent': UA, 'Accept': 'image/*' } });
    if (!res.ok) throw new Error(`图片下载失败 HTTP ${res.status}`);
    const ct = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!ct.startsWith('image/')) throw new Error('附件不是图片');
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!bytes.length || bytes.length > maxBytes) throw new Error('图片太大或为空');
    return `data:${ct};base64,${base64(bytes)}`;
  } finally {
    clearTimeout(timer);
  }
}

export function attachmentKind(a) {
  const ct = String(a?.content_type || '').toLowerCase();
  if (ct.startsWith('image/')) return '图片';
  if (ct.startsWith('video/')) return '视频';
  if (ct === 'voice' || ct.startsWith('audio/')) return '语音';
  if (ct === 'file' || a?.filename) return '文件';
  return '附件';
}

export function describeAttachments(attachments) {
  return (Array.isArray(attachments) ? attachments : [])
    .map((a) => {
      const kind = attachmentKind(a);
      const name = a?.filename ? ` ${a.filename}` : '';
      const size = Number(a?.size) > 0 ? ` ${Math.round(Number(a.size) / 1024)}KB` : '';
      return `[${kind}${name}${size}]`;
    })
    .join(' ');
}
