// 扩展系统:
//   内置扩展 —— 随服务一起运行的工具组(计算器/时间/联网/随机/编解码/群聊记忆...),可以逐个关掉
//   外置扩展 —— 面板里配置的外部 HTTP 接口,自动变成 Agent 工具,还能往面板挂页面
// 表:exts(id, name, description, kind, config, enabled, builtin, sort, updated_at)

import { ensureSchema } from '../store/db.js';

export const BUILTIN_EXTS = [
  { id: 'calc', name: '计算器', description: '精确算术计算,避免模型心算出错', tools: ['calc'] },
  { id: 'clock', name: '时间', description: '查询当前日期时间(可带时差)', tools: ['now'] },
  { id: 'web', name: '联网搜索', description: '关键词搜索 + 网页正文读取(需要先在 Agent 设置里配置接口)', tools: ['web_search', 'fetch_url'] },
  { id: 'dice', name: '随机抽签', description: '掷骰子、抽签、随机选一个', tools: ['random'] },
  { id: 'encode', name: '编解码', description: 'Base64 / URL / Hex / JSON 互转', tools: ['encode'] },
  { id: 'dashboard', name: '中转站用量', description: '查询 AI 中转站面板的实时用量', tools: ['query_dashboard'] },
  { id: 'memory', name: '会话记忆', description: '记住 / 回忆 / 忘掉会话里的信息', tools: ['remember', 'recall', 'forget'] },
  { id: 'groups', name: '群聊记忆', description: '查询群消息缓存、按关键词找群', tools: ['group_recent', 'group_find'] },
];

export function builtinIds() {
  return BUILTIN_EXTS.map((b) => b.id);
}

// 读取扩展状态:内置的合并默认值,外置的直接列出
export async function loadExts(env) {
  let rows = [];
  try {
    await ensureSchema(env.DB);
    const r = await env.DB.prepare('SELECT * FROM exts ORDER BY sort, updated_at').all();
    rows = r.results || [];
  } catch {
    rows = [];
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  const builtin = BUILTIN_EXTS.map((b) => {
    const r = byId.get(b.id);
    return {
      id: b.id,
      kind: 'builtin',
      name: b.name,
      description: b.description,
      tools: b.tools,
      enabled: r ? !!r.enabled : true,
      updatedAt: Number(r?.updated_at || 0),
    };
  });
  const external = [];
  for (const r of rows) {
    if (r.kind !== 'external') continue;
    let config = {};
    try {
      config = JSON.parse(r.config || '{}');
    } catch {
      config = {};
    }
    external.push({
      id: r.id,
      kind: 'external',
      name: r.name || r.id,
      description: r.description || '',
      enabled: !!r.enabled,
      config,
      updatedAt: Number(r.updated_at || 0),
    });
  }
  return { builtin, external };
}

// 保存扩展状态(内置=只改 enabled;外置=整条写入)
export async function saveExt(env, { id, kind = 'builtin', name = '', description = '', config = {}, enabled = true, sort = 0 }) {
  await ensureSchema(env.DB);
  await env.DB.prepare(
    `INSERT INTO exts (id, name, description, kind, config, enabled, builtin, sort, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description,
       config = excluded.config, enabled = excluded.enabled, updated_at = excluded.updated_at`,
  ).bind(
    String(id), String(name || ''), String(description || ''), kind,
    JSON.stringify(config || {}), enabled ? 1 : 0, kind === 'builtin' ? 1 : 0, sort, Date.now(),
  ).run();
}

export async function removeExt(env, id) {
  await ensureSchema(env.DB);
  await env.DB.prepare('DELETE FROM exts WHERE id = ?').bind(String(id)).run();
}

// 所有处于开启状态的内置工具名
export function enabledToolSet(exts) {
  const set = new Set();
  for (const b of exts?.builtin || []) {
    if (!b.enabled) continue;
    for (const t of b.tools) set.add(t);
  }
  return set;
}

export function safeToolName(extId, toolName) {
  const base = String(toolName || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
  const id = String(extId || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 10);
  return `x_${id}_${base}`.slice(0, 64);
}

// 外置扩展的工具定义 -> OpenAI 风格 tools + 查找表
export function externalToolDefs(exts) {
  const defs = [];
  const map = new Map();
  for (const e of exts?.external || []) {
    if (!e.enabled) continue;
    const tools = Array.isArray(e.config?.tools) ? e.config.tools : [];
    for (const t of tools) {
      if (!t || !t.name || !t.endpoint) continue;
      const name = safeToolName(e.id, t.name);
      defs.push({
        type: 'function',
        function: {
          name,
          description: String(t.description || `「${e.name}」扩展提供的工具`).slice(0, 500),
          parameters: t.parameters && typeof t.parameters === 'object'
            ? t.parameters
            : { type: 'object', properties: {} },
        },
      });
      map.set(name, { ext: e, tool: t });
    }
  }
  return { defs, map };
}

function argOf(args, path) {
  let cur = args;
  for (const seg of String(path || '').split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = cur[seg];
  }
  return cur;
}

// {{name}} 模板:URL/头里做 URI 编码,JSON body 里做字符串转义
function fillTemplate(str, args, jsonMode) {
  return String(str ?? '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => {
    const v = argOf(args, k);
    if (jsonMode) return JSON.stringify(v === undefined ? '' : v).slice(1, -1);
    return encodeURIComponent(v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  });
}

export async function runExternalTool(entry, args, log = () => {}) {
  const { ext, tool } = entry;
  const method = String(tool.method || 'POST').toUpperCase();
  const url = fillTemplate(tool.endpoint, args, false);
  const headers = { 'User-Agent': 'NOMO-QQBot/4.0', ...(tool.headers && typeof tool.headers === 'object' ? tool.headers : {}) };
  for (const [k, v] of Object.entries(headers)) headers[k] = fillTemplate(String(v), args, false);
  let body;
  if (method !== 'GET' && method !== 'HEAD') {
    if (tool.body && String(tool.body).trim()) {
      body = fillTemplate(String(tool.body), args, true);
    } else {
      body = JSON.stringify(args || {});
    }
    if (!headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/json';
  }
  log(`外部扩展 ${ext.name} -> ${method} ${url}`);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1000, Math.min(60000, Number(tool.timeoutMs) || 20000)));
  try {
    const res = await fetch(url, { method, headers, body, signal: ctrl.signal, redirect: 'follow' });
    const text = await res.text();
    if (!res.ok) return `扩展「${ext.name}」调用失败:HTTP ${res.status} ${text.slice(0, 200)}`;
    let out = text;
    const ct = String(res.headers.get('content-type') || '');
    if (/json/i.test(ct) || text.trim().startsWith('{') || text.trim().startsWith('[')) {
      try {
        const json = JSON.parse(text);
        const path = tool.responsePath ? String(tool.responsePath) : '';
        let val = json;
        if (path) {
          for (const seg of path.split('.')) {
            if (val && typeof val === 'object') val = val[seg];
          }
        }
        out = typeof val === 'string' ? val : JSON.stringify(val);
      } catch {
        /* 原样返回 */
      }
    }
    return String(out).slice(0, 2600) || '(扩展返回了空内容)';
  } catch (e) {
    return `扩展「${ext.name}」调用出错:${e?.message || e}`;
  } finally {
    clearTimeout(timer);
  }
}
