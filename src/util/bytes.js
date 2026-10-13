const HEX = '0123456789abcdef';

export function hexToBytes(hex) {
  const s = String(hex || '').trim();
  if (s.length % 2 !== 0) throw new Error('hex 长度必须是偶数');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    const b = parseInt(s.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(b)) throw new Error('hex 含非法字符');
    out[i] = b;
  }
  return out;
}

export function bytesToHex(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = '';
  for (let i = 0; i < u.length; i++) {
    out += HEX[u[i] >> 4] + HEX[u[i] & 15];
  }
  return out;
}

export function utf8(str) {
  return new TextEncoder().encode(str);
}

export function concatBytes(...parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
