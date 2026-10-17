import { ensureSchema, all, one, run } from '../store/db.js';
import { logWrite } from '../store/logs.js';

const PROTOCOL = '2025-06-18';

function rid() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  const buf = new Uint8Array(6);
  crypto.getRandomValues(buf);
  let s = '';
  for (const b of buf) s += chars[b % chars.length];
  return s;
}

function parseHeaders(raw) {
  if (!raw) return {};
  try {
    const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}

function sseExtract(text) {
  const out = [];
  for (const block of String(text).split(/\n\n/)) {
    const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
    if (!data) continue;
    try {
      out.push(JSON.parse(data));
    } catch {
      /* 忽略非 JSON 数据 */
    }
  }
  return out;
}

async function readRpc(res) {
  const ct = res.headers.get('Content-Type') || '';
  const text = await res.text();
  if (ct.includes('text/event-stream')) return sseExtract(text);
  try {
    const j = JSON.parse(text);
    return Array.isArray(j) ? j : [j];
  } catch {
    return sseExtract(text);
  }
}

async function httpSession(server, steps) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'User-Agent': 'NOMO-QQBot/4.0',
    ...parseHeaders(server.headers),
  };
  const out = [];
  let sessionId = '';
  for (const msg of steps) {
    const res = await fetch(server.url, { method: 'POST', headers: { ...headers, ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}) }, body: JSON.stringify(msg) });
    const sid = res.headers.get('Mcp-Session-Id');
    if (sid) sessionId = sid;
    if (!res.ok) throw new Error(`MCP 返回 HTTP ${res.status}:${(await res.text()).slice(0, 200)}`);
    if (msg.id === undefined) continue;
    const list = await readRpc(res);
    const hit = list.find((x) => x && x.id === msg.id);
    out.push(hit || list[0] || null);
  }
  return out;
}

async function sseSession(server, steps) {
  const headers = { Accept: 'text/event-stream', 'User-Agent': 'NOMO-QQBot/4.0', ...parseHeaders(server.headers) };
  const res = await fetch(server.url, { headers });
  if (!res.ok || !res.body) throw new Error(`MCP SSE 连接失败 HTTP ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let endpoint = '';
  const seen = [];
  const deadline = Date.now() + 20000;

  async function pump(until) {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev = {};
        for (const line of block.split('\n')) {
          const i = line.indexOf(':');
          if (i < 0) continue;
          ev[line.slice(0, i).trim()] = line.slice(i + 1).trim();
        }
        if (ev.event === 'endpoint' && ev.data) endpoint = new URL(ev.data, server.url).toString();
        if (ev.data) {
          try {
            seen.push(JSON.parse(ev.data));
          } catch {
            /* 忽略 */
          }
        }
      }
      if (endpoint && until && seen.some((x) => x && x.id === until)) break;
      if (endpoint && !until && seen.length) break;
    }
  }

  await pump(null);
  if (!endpoint) {
    try {
      reader.cancel();
    } catch {
      /* ignore */
    }
    throw new Error('MCP SSE 没有返回 endpoint 事件');
  }
  const out = [];
  const post = (msg) => fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...parseHeaders(server.headers) },
    body: JSON.stringify(msg),
  });
  for (const msg of steps) {
    const r = await post(msg);
    if (!r.ok) throw new Error(`MCP 消息发送失败 HTTP ${r.status}`);
    if (msg.id === undefined) continue;
    await pump(msg.id);
    const hit = seen.find((x) => x && x.id === msg.id);
    out.push(hit || null);
  }
  try {
    reader.cancel();
  } catch {
    /* ignore */
  }
  return out;
}

function steps(extra = []) {
  return [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'NOMO-QQBot', version: '4.0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    ...extra,
  ];
}

export async function probe(server, extra = []) {
  const errs = [];
  const modes = server.transport === 'auto' ? ['http', 'sse'] : [server.transport === 'sse' ? 'sse' : 'http'];
  for (const mode of modes) {
    try {
      const list = mode === 'sse' ? await sseSession(server, steps(extra)) : await httpSession(server, steps(extra));
      return { mode, list };
    } catch (e) {
      errs.push(`${mode}: ${String(e?.message || e)}`);
    }
  }
  throw new Error(errs.join(' | '));
}

export async function listMcp(env) {
  await ensureSchema(env.DB);
  const rows = await all(env.DB, 'SELECT * FROM mcp ORDER BY rowid DESC');
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    url: r.url,
    transport: r.transport,
    headers: parseHeaders(r.headers),
    enabled: !!r.enabled,
    tools: parseHeaders(r.tools) && r.tools ? JSON.parse(r.tools) : { list: [], enabled: [] },
    status: r.status || '',
    note: r.note || '',
    lastCheck: r.last_check,
  }));
}

export async function getMcp(env, id) {
  await ensureSchema(env.DB);
  const r = await one(env.DB, 'SELECT * FROM mcp WHERE id = ?', id);
  if (!r) return null;
  let tools = { list: [], enabled: [] };
  try {
    tools = r.tools ? JSON.parse(r.tools) : tools;
  } catch {
    /* ignore */
  }
  return { id: r.id, name: r.name, url: r.url, transport: r.transport, headers: parseHeaders(r.headers), enabled: !!r.enabled, tools };
}

export async function addMcp(env, { name, url, transport, headers }) {
  if (!name || !url) return { error: '名称和地址都要填' };
  await ensureSchema(env.DB);
  const id = rid();
  const server = { id, name, url, transport: transport || 'auto', headers: JSON.stringify(headers || {}) };
  await run(env.DB,
    'INSERT INTO mcp (id, name, url, transport, headers, enabled, tools, status, last_check) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)',
    id, name, url, server.transport, server.headers, JSON.stringify({ list: [], enabled: [] }), '未测试', null);
  try {
    const r = await testMcp(env, id);
    return { id, note: r.error ? `已添加,但连接失败:${r.error}` : `已添加,发现 ${r.count} 个工具` };
  } catch (e) {
    return { id, note: `已添加,但连接失败:${String(e?.message || e)}` };
  }
}

export async function updateMcp(env, id, patch) {
  const cur = await getMcp(env, id);
  if (!cur) return { error: '不存在' };
  if (patch.tool !== undefined) {
    const tools = cur.tools || { list: [], enabled: [] };
    const set = new Set(tools.enabled || []);
    if (patch.on) set.add(patch.tool);
    else set.delete(patch.tool);
    tools.enabled = [...set];
    await run(env.DB, 'UPDATE mcp SET tools = ? WHERE id = ?', JSON.stringify(tools), id);
    return { ok: true };
  }
  if (patch.enabled !== undefined) {
    await run(env.DB, 'UPDATE mcp SET enabled = ? WHERE id = ?', patch.enabled ? 1 : 0, id);
  }
  if (patch.name !== undefined || patch.url !== undefined || patch.headers !== undefined) {
    await run(env.DB, 'UPDATE mcp SET name = ?, url = ?, headers = ? WHERE id = ?',
      patch.name ?? cur.name, patch.url ?? cur.url, JSON.stringify(patch.headers ?? cur.headers), id);
  }
  return { ok: true };
}

export async function removeMcp(env, id) {
  await run(env.DB, 'DELETE FROM mcp WHERE id = ?', id);
}

export async function testMcp(env, id) {
  const s = await getMcp(env, id);
  if (!s) return { error: '服务器不存在' };
  try {
    const r = await probe(s, [{ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }]);
    const hit = r.list.find((x) => x && x.id === 2) || r.list[r.list.length - 1];
    const tools = ((hit && hit.result && hit.result.tools) || []).map((t) => ({ name: t.name, description: String(t.description || '').slice(0, 300) }));
    const enabled = (s.tools.enabled || []).filter((n) => tools.some((t) => t.name === n));
    const next = { list: tools, enabled: enabled.length ? enabled : tools.map((t) => t.name) };
    await run(env.DB, 'UPDATE mcp SET tools = ?, status = ?, last_check = ?, note = ? WHERE id = ?',
      JSON.stringify(next), `已连接(${r.mode})`, Date.now(), '', id);
    return { ok: true, count: tools.length, tools, mode: r.mode };
  } catch (e) {
    const msg = String(e?.message || e).slice(0, 400);
    await run(env.DB, 'UPDATE mcp SET status = ?, last_check = ?, note = ? WHERE id = ?', '连接失败', Date.now(), msg, id);
    return { error: msg };
  }
}

function safeName(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48);
}

export async function mcpToolDefs(env) {
  const servers = await listMcp(env);
  const defs = [];
  const map = new Map();
  for (const s of servers) {
    if (!s.enabled) continue;
    for (const t of s.tools.list || []) {
      if (!(s.tools.enabled || []).includes(t.name)) continue;
      const full = safeName(`mcp_${s.id}_${t.name}`);
      map.set(full, { serverId: s.id, tool: t.name });
      defs.push({
        type: 'function',
        function: {
          name: full,
          description: `[MCP:${s.name}] ${t.description || t.name}`.slice(0, 900),
          parameters: { type: 'object', properties: {}, required: [], additionalProperties: true },
        },
      });
    }
  }
  return { defs, map };
}

export async function callMcp(env, serverId, toolName, args) {
  const s = await getMcp(env, serverId);
  if (!s) return 'MCP 服务器不存在';
  try {
    const r = await probe(s, [{ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: toolName, arguments: args || {} } }]);
    const hit = r.list.find((x) => x && x.id === 2) || r.list[r.list.length - 1];
    if (!hit) return 'MCP 没有返回结果';
    if (hit.error) return `MCP 报错:${JSON.stringify(hit.error).slice(0, 400)}`;
    const c = hit.result?.content;
    if (Array.isArray(c)) {
      return c.map((x) => (x.type === 'text' ? x.text : `[${x.type}]`)).join('\n').slice(0, 4000);
    }
    return JSON.stringify(hit.result || {}).slice(0, 4000);
  } catch (e) {
    const msg = String(e?.message || e);
    await logWrite(env, 'warn', 'mcp', `调用 ${s.name}.${toolName} 失败:${msg}`);
    return `MCP 调用失败:${msg}`;
  }
}
