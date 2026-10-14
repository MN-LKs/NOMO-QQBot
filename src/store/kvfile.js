const MIME = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  pdf: 'application/pdf',
  zip: 'application/zip',
};

export function mimeFor(path) {
  const ext = String(path).split('.').pop().toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

export function isTextCt(ct) {
  return /^text\/|json|javascript|xml|svg|x-www-form-urlencoded/.test(String(ct || ''));
}

export function isImageCt(ct) {
  return /^image\//.test(String(ct || '')) && !/svg/.test(ct);
}

export async function gzipBytes(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function gunzipBytes(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function keyFor(siteId, path) {
  return `f/${siteId}/${String(path).replace(/^\/+/, '')}`;
}

export async function putFile(env, siteId, path, content, ct) {
  const type = ct || mimeFor(path);
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : new Uint8Array(content);
  const rawSize = bytes.byteLength;
  let stored = bytes;
  let gz = 0;
  // 压缩阈值压到 96 字节:小 HTML/CSS/JSON 也一起压,存储利用率更高
  if (isTextCt(type) && rawSize > 96) {
    try {
      const packed = await gzipBytes(bytes);
      if (packed.byteLength < rawSize) {
        stored = packed;
        gz = 1;
      }
    } catch {
      gz = 0;
    }
  }
  await env.STORE.put(keyFor(siteId, path), stored);
  return { rawSize, size: stored.byteLength, gz, ct: type };
}

export async function getFile(env, siteId, path, gz) {
  const raw = await env.STORE.get(keyFor(siteId, path), 'arrayBuffer');
  if (!raw) return null;
  const bytes = new Uint8Array(raw);
  if (gz) {
    try {
      return await gunzipBytes(bytes);
    } catch {
      return bytes;
    }
  }
  return bytes;
}

/**
 * 不查数据库直接读:靠 gzip 魔数(0x1f 0x8b)判断是否压缩。
 * 压缩只对文本做,文本文件不会以这两个字节开头;万一解压失败也原样返回,不会损坏数据。
 * 省掉一次 D1 查询,页面加载更快。
 */
export async function getFileAuto(env, siteId, path) {
  const raw = await env.STORE.get(keyFor(siteId, path), 'arrayBuffer');
  if (!raw) return null;
  const bytes = new Uint8Array(raw);
  if (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try {
      return await gunzipBytes(bytes);
    } catch {
      return bytes;
    }
  }
  return bytes;
}

export async function delFile(env, siteId, path) {
  await env.STORE.delete(keyFor(siteId, path));
}

export async function delAll(env, siteId) {
  let cursor = undefined;
  let removed = 0;
  for (let i = 0; i < 10; i++) {
    const page = await env.STORE.list({ prefix: `f/${siteId}/`, cursor, limit: 1000 });
    for (const k of page.keys) {
      await env.STORE.delete(k.name);
      removed++;
    }
    if (page.list_complete) break;
    cursor = page.cursor;
  }
  return removed;
}
