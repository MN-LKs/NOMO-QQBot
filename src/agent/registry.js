/**
 * 万物工具架构 —— 统一工具注册表。
 *
 * 面板上能看到、AI 能调用的东西一共有四类来源:
 *   internal  内置工具(exec.js 的 executeTool 分发,受扩展开关控制)
 *   external  外部 HTTP 扩展(exts.js 的 externalToolDefs)
 *   mcp       MCP 服务器工具(mcp.js 的 mcpToolDefs)
 *   model     万能模型层提供的能力(imageGen / ocr / asr / tts / compress)
 *
 * 以前这四类分散在各处,面板「工具总览」只能靠拼字符串展示,AI 也无法自己新增工具。
 * 现在由这里统一汇总成一份「注册表」,同时承担两个职责:
 *   1. 给面板用:一份列表说清楚「有什么工具、从哪来、开没开、长什么样」
 *   2. 给 AI 用:自写 JS 工具(kind='script')也在这里注册,生成工具定义
 *
 * 自写工具的执行走 jsmini 沙盒(core/jsmini.js),与「模块」页的预制后端同一套解释器,
 * 所以不引入第二个运行时。脚本里可以用 ctx.args / ctx.fetch / ctx.log / ctx.store。
 */

import { BUILTIN_EXTS } from './exts.js';

/** 四个来源的分类元信息(面板展示用) */
export const SOURCE_META = {
  internal: { label: '内置工具', icon: '🧰', desc: '随机器人一起提供,可在「扩展管理」逐个开关' },
  external: { label: '外部扩展', icon: '🔌', desc: '把外部 HTTP 接口包装成工具(面板里配置)' },
  mcp: { label: 'MCP 工具', icon: '🧲', desc: '来自 MCP 服务器(面板里配置)' },
  model: { label: '模型能力', icon: '🧠', desc: '由万能模型层提供(OCR / ASR / TTS / 图像 / 压缩)' },
  script: { label: '自写工具', icon: '✍️', desc: 'AI 或管理员写的 JS 工具,即时生效' },
};

export const SOURCES = Object.keys(SOURCE_META);

/** 内置工具清单:与 exec.js 的 case 一一对应 */
export const INTERNAL_TOOLS = [
  ['calc', '计算器', '精确算术,避免模型心算出错'],
  ['now', '时间', '当前日期时间,可带时差'],
  ['web_search', '联网搜索', '关键词搜索,需要配搜索接口'],
  ['fetch_url', '网页读取', '抓取网页正文或 JSON,可能走 reader 接口'],
  ['random', '随机', '掷骰子 / 抽签 / 随机选一个'],
  ['encode', '编解码', 'Base64 / URL / Hex / JSON 互转'],
  ['query_dashboard', '中转站用量', '查询 AI 中转站面板实时用量'],
  ['remember', '记住', '把信息存进当前会话长期记忆'],
  ['recall', '回忆', '列出当前会话记住的内容'],
  ['forget', '忘掉', '删掉某条长期记忆'],
  ['group_recent', '群聊近况', '读这个群最近的聊天记录缓存'],
  ['group_find', '找群', '按关键词找包含某内容的群'],
  ['motd', 'MOTD 查询', '查 Minecraft 服务器状态'],
  ['deploy_site', '部署网页', '把前端代码部署成可访问的网址'],
  ['update_site', '更新网页', '改动已部署的项目'],
  ['list_sites', '部署列表', '列出当前在线的部署'],
  ['delete_site', '删除部署', '销毁一个部署并回收空间'],
  ['draw_image', '生成图片', '按描述生成图片(需配图像模型)'],
];

/** 工具名 -> 分类。没列到的内部工具按 internal 处理 */
const NAME_SOURCE = new Map(INTERNAL_TOOLS.map((t) => [t[0], 'internal']));

export function sourceOfToolName(name) {
  return NAME_SOURCE.get(name) || 'internal';
}

/**
 * 汇总一份完整注册表。
 * @param {object} opts
 *   opts.execDefs      buildTools 产出的工具定义数组(含 external/mcp/model/script)
 *   opts.toolSet       启用中的内置工具名集合(null = 全开)
 *   opts.exts          loadExts 的结果(builtin + external)
 *   opts.mcp           mcpToolDefs 的结果(defs + map)
 * @returns {{rows: Array, bySource: object, stats: object}}
 */
export function buildRegistry(opts = {}) {
  const defs = Array.isArray(opts.execDefs) ? opts.execDefs : [];
  const toolSet = opts.toolSet || null;
  const mcpMap = opts.mcp?.map || new Map();
  const externalMap = new Map();
  for (const e of opts.exts?.external || []) {
    // 自写工具(kind='script')单独归 script 桶,不能算成外部 HTTP 扩展
    if (e.kind === 'script') continue;
    for (const t of Array.isArray(e.config?.tools) ? e.config.tools : []) {
      if (t?.name) externalMap.set(safeName(e.id, t.name), e);
    }
  }
  // 自写工具:kind='script' 的扩展,工具名带 x_ 前缀
  const scriptMap = new Map();
  for (const e of opts.exts?.external || []) {
    if (e.kind !== 'script') continue;
    for (const t of Array.isArray(e.config?.tools) ? e.config.tools : []) {
      if (t?.name) scriptMap.set(safeName(e.id, t.name), { ext: e, tool: t });
    }
  }

  const rows = [];
  for (const d of defs) {
    const name = d?.function?.name || '';
    if (!name) continue;
    let source = 'internal';
    let owner = 'NOMO';
    let desc = '';
    let params = d.function.parameters || { type: 'object', properties: {} };
    if (mcpMap.has(name)) {
      source = 'mcp';
      owner = mcpMap.get(name).serverName || mcpMap.get(name).serverId || 'MCP';
    } else if (externalMap.has(name)) {
      source = 'external';
      owner = externalMap.get(name).name || externalMap.get(name).id;
    } else if (scriptMap.has(name)) {
      source = 'script';
      owner = scriptMap.get(name).ext.name || scriptMap.get(name).ext.id;
    } else if (name === 'draw_image' || name === 'read_image' || name === 'transcribe_voice' || name === 'speak_text') {
      source = 'model';
      owner = '万能模型层';
    }
    desc = String(d.function.description || '');
    const enabled = source === 'internal' ? (toolSet ? toolSet.has(name) : true) : true;
    rows.push({
      name, source, owner, description: desc, parameters: params, enabled,
      argCount: Object.keys(params?.properties || {}).length,
      required: Array.isArray(params?.required) ? params.required : [],
    });
  }

  const bySource = {};
  for (const s of SOURCES) bySource[s] = rows.filter((r) => r.source === s);
  return {
    rows,
    bySource,
    stats: {
      total: rows.length,
      ...Object.fromEntries(SOURCES.map((s) => [s, bySource[s].length])),
    },
  };
}

function safeName(extId, toolName) {
  const base = String(toolName || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
  const id = String(extId || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 10);
  return `x_${id}_${base}`.slice(0, 64);
}

/**
 * AI 自写工具的保存。本质就是一条 kind='script' 的外置扩展,
 * config.tools = [{ name, description, parameters, code }]。
 * code 用 ctx.args / ctx.fetch / ctx.log / ctx.store,return 一个值即可。
 */
export function scriptToolDef(ext, tool) {
  const props = {};
  const required = [];
  const params = tool?.parameters && typeof tool.parameters === 'object' ? tool.parameters : {};
  for (const [k, v] of Object.entries(params.properties || {})) {
    props[k] = { type: v?.type || 'string', description: String(v?.description || '') };
    if (v?.required || (params.required || []).includes(k)) required.push(k);
  }
  return {
    type: 'function',
    function: {
      name: safeName(ext.id, tool.name),
      description: `[自写工具/${ext.name}] ${String(tool.description || '').slice(0, 600)}`,
      parameters: { type: 'object', properties: props, required },
    },
  };
}

/** 自写工具的执行:走 jsmini 沙盒,超时与大小都和模块一致 */
export async function runScriptTool(entry, args, ctx = {}) {
  const { ext, tool } = entry;
  const code = String(tool?.code || '');
  if (!code.trim()) return '这个自写工具还没有写代码。';
  if (code.length > 20000) return '自写工具代码超过 20000 字上限。';
  try {
    const r = await ctx.runSandbox(code, {
      args: args || {},
      fetch: (u, init) => ctx.sandboxFetch(u, init),
      log: (m) => ctx.log && ctx.log(`[自写工具 ${ext.name}] ${m}`),
      store: ctx.store,
      now: () => Date.now(),
    }, { timeoutMs: Math.max(1000, Math.min(30000, Number(tool.timeoutMs) || 8000)) });
    if (!r.ok) return `自写工具执行失败:${r.error}`;
    const v = r.value;
    if (v === undefined || v === null) return '(自写工具没有返回内容)';
    return typeof v === 'string' ? v.slice(0, 2600) : JSON.stringify(v).slice(0, 2600);
  } catch (e) {
    return `自写工具出错:${e?.message || e}`;
  }
}

/** 面板「工具总览」用的一句话状态 */
export function registrySummary(reg) {
  const s = reg?.stats || { total: 0 };
  const parts = SOURCES.filter((k) => s[k]).map((k) => `${SOURCE_META[k].label} ${s[k]}`);
  return parts.length ? `共 ${s.total} 个工具:${parts.join(' / ')}` : '还没有可用工具';
}
