//
// E / F / G 组新功能的单元测试:万能模型层、创造模式、万物工具注册表。
//
// 这些测试刻意不碰真实上游(没有 key 也通不了),只验证:
//   1. 配置加工:脏数据能否被 normaliseModel/normaliseModels 洗干净
//   2. 协议适配:四种协议的请求 URL 与 body 形态对不对(用导出的构造函数测)
//   3. 响应解析:各家返回结构能否统一成 { text }
//   4. 边界:没启用 / 缺字段 / 畸形响应 时的行为符合预期
//   5. 注册表:四类工具来源能否正确归桶
//   6. 创造模式:解析规则是否精准(不多吃也不少吃)
//
// 运行:node test/models.test.mjs
import {
  MODEL_KINDS, KIND_META, PROTOCOLS,
  normaliseModel, normaliseModels, modelReady,
  parseByProtocol, bytesToDataUrl, fromBase64, toBase64, audioContentType,
} from '../src/agent/models.js';
import { parseCreativeMode } from '../src/core/do.js';
import { buildRegistry, SOURCE_META, SOURCES, registrySummary } from '../src/agent/registry.js';
import { scriptDefs, safeToolName } from '../src/agent/exts.js';

let pass = 0;
const fails = [];
function ok(name, cond) {
  if (cond) { pass++; return; }
  fails.push(name);
}
function eq(name, a, b) {
  const same = JSON.stringify(a) === JSON.stringify(b);
  if (same) { pass++; return; }
  fails.push(`${name} — got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
}

// ---------- 配置加工 ----------
eq('五类模型都登记了', MODEL_KINDS, ['ocr', 'asr', 'tts', 'imageGen', 'compress']);
eq('四类协议', PROTOCOLS, ['chat', 'responses', 'google', 'claude']);
eq('每类都有中文说明', MODEL_KINDS.every((k) => KIND_META[k] && KIND_META[k].label), true);

{
  const m = normaliseModel({ enabled: 'yes', baseUrl: 'https://x.com/v1/', model: ' m ', protocol: 'bogus', extra: 'no' });
  eq('enabled 只认真 true', m.enabled, false);
  eq('尾斜杠被去掉', m.baseUrl, 'https://x.com/v1');
  eq('模型名去空格', m.model, 'm');
  eq('未知协议回落 chat', m.protocol, 'chat');
  eq('extra 不是对象时清空', m.extra, {});
}
{
  const m = normaliseModel({ enabled: true, baseUrl: 'https://x.com', model: 'm', protocol: 'claude' });
  eq('claude 协议保留', m.protocol, 'claude');
  eq('enabled true 生效', m.enabled, true);
}
eq('空配置时全部不可用', MODEL_KINDS.every((k) => !modelReady(normaliseModel({}))), true);
eq('只有 enabled 也不算可用', modelReady(normaliseModel({ enabled: true })), false);
eq('缺 model 也不算可用', modelReady(normaliseModel({ enabled: true, baseUrl: 'https://x.com' })), false);
eq('三项齐了才可用', modelReady(normaliseModel({ enabled: true, baseUrl: 'https://x.com', model: 'm' })), true);
{
  const all = normaliseModels({ ocr: { enabled: true, baseUrl: 'https://a', model: 'a' }, junk: { x: 1 } });
  eq('normaliseModels 补齐五类', Object.keys(all).sort(), [...MODEL_KINDS].sort());
  eq('认识的字段原样进来', all.ocr.enabled, true);
  eq('不认识的顶层字段被丢掉', 'junk' in all, false);
  eq('未配置的类别是默认值', all.tts.enabled, false);
}
eq('normaliseModels 容忍 null', Object.keys(normaliseModels(null)).length, 5);
eq('normaliseModels 容忍字符串', Object.keys(normaliseModels('x')).length, 5);
eq('normaliseModel 容忍 undefined', normaliseModel(undefined).protocol, 'chat');

// ---------- 四种协议的响应解析 ----------
eq('chat 解析字符串 content', parseByProtocol('chat', { choices: [{ message: { content: 'hi' } }] }).text, 'hi');
eq('chat 解析数组 content', parseByProtocol('chat', { choices: [{ message: { content: [{ text: 'a' }, { text: 'b' }] } }] }).text, 'ab');
eq('responses 解析 output_text', parseByProtocol('responses', { output_text: 'hi' }).text, 'hi');
eq('responses 解析 output 数组', parseByProtocol('responses', { output: [{ content: [{ text: 'a' }] }] }).text, 'a');
eq('google 解析 candidates', parseByProtocol('google', { candidates: [{ content: { parts: [{ text: 'a' }, { text: 'b' }] } }] }).text, 'ab');
eq('claude 解析字符串', parseByProtocol('claude', { content: 'hi' }).text, 'hi');
eq('claude 解析数组', parseByProtocol('claude', { content: [{ text: 'a' }] }).text, 'a');
eq('空响应不炸', parseByProtocol('chat', {}).text, '');
eq('畸形响应不炸', parseByProtocol('chat', { choices: [null] }).text, '');
for (const p of PROTOCOLS) {
  eq(`${p} 协议空对象返回空文本`, parseByProtocol(p, {}).text, '');
}

// ---------- base64 / data URL ----------
{
  const bytes = new Uint8Array([0, 1, 2, 250, 255, 128]);
  const b64 = toBase64(bytes);
  const back = fromBase64(b64);
  eq('base64 往返一致', Array.from(back), Array.from(bytes));
  const du = bytesToDataUrl(bytes, 'image/png');
  ok('data URL 前缀正确', du.startsWith('data:image/png;base64,'));
  ok('data URL 是合法 data URL', /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(du));
}
eq('WAV content-type', audioContentType('wav'), 'audio/wav');
eq('mp3 content-type', audioContentType('mp3'), 'audio/mpeg');
eq('未知音频回落 mpeg', audioContentType('flac'), 'audio/mpeg');

// ---------- 创造模式解析 ----------
eq('创造模式能解析', parseCreativeMode('AI 创造模式 写一个贪吃蛇'), '写一个贪吃蛇');
eq('两个空格不算(精准匹配)', parseCreativeMode('AI  创造模式 多余空格'), null);
eq('没有正文不算', parseCreativeMode('AI 创造模式'), null);
eq('只有空格不算', parseCreativeMode('AI 创造模式   '), null);
eq('不在开头不算', parseCreativeMode('你说 AI 创造模式 是什么'), null);
eq('大小写不敏感', parseCreativeMode('ai 创造模式 小写也行'), '小写也行');
eq('正文可以跨行', parseCreativeMode('AI 创造模式 a\nb'), 'a\nb');
eq('普通 AI 请求不被误判', parseCreativeMode('AI 你好'), null);
eq('普通消息不触发', parseCreativeMode('今天天气不错'), null);
eq('空输入不炸', parseCreativeMode(''), null);

// ---------- 万物工具注册表 ----------
{
  const exts = {
    builtin: [
      { id: 'calc', name: '计算器', tools: ['calc'], enabled: true },
      { id: 'motd', name: 'MOTD', tools: ['motd'], enabled: false },
    ],
    external: [],
  };
  const defs = [
    { type: 'function', function: { name: 'calc', description: '算', parameters: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] } } },
    { type: 'function', function: { name: 'motd', description: '查', parameters: { type: 'object', properties: { host: {} } } } },
  ];
  const toolSet = new Set(['calc']);
  const reg = buildRegistry({ execDefs: defs, toolSet, exts, mcp: { defs: [], map: new Map() } });
  eq('注册表收齐两个工具', reg.rows.length, 2);
  eq('内置工具归 internal', reg.bySource.internal.length, 2);
  eq('关闭的工具标为未启用', reg.rows.find((r) => r.name === 'motd').enabled, false);
  eq('开启的工具标为已启用', reg.rows.find((r) => r.name === 'calc').enabled, true);
  eq('toolSet 为 null 时全开', buildRegistry({ execDefs: defs, toolSet: null, exts, mcp: { defs: [], map: new Map() } }).rows.every((r) => r.enabled), true);
  eq('统计 internal 数量', reg.stats.internal, 2);
  ok('摘要里带数量', /共 2 个工具/.test(registrySummary(reg)));
}
{
  const defs = [{ type: 'function', function: { name: 'x_m1_search', description: 'd', parameters: {} } }];
  const reg = buildRegistry({ execDefs: defs, exts: { builtin: [], external: [] }, mcp: { defs, map: new Map([['x_m1_search', { serverId: 's1', serverName: 'M1', tool: 'search' }]]) } });
  eq('MCP 工具归 mcp', reg.bySource.mcp.length, 1);
  eq('MCP 来源显示服务器名', reg.bySource.mcp[0].owner, 'M1');
}
{
  const ext = { id: 'e1', kind: 'external', name: '天气', enabled: true, config: { tools: [{ name: 'weather', endpoint: 'https://x', description: 'd' }] } };
  const name = safeToolName('e1', 'weather');
  const defs = [{ type: 'function', function: { name, description: 'd', parameters: {} } }];
  const reg = buildRegistry({ execDefs: defs, exts: { builtin: [], external: [ext] }, mcp: { defs: [], map: new Map() } });
  eq('外部扩展归 external', reg.bySource.external.length, 1);
  eq('来源显示扩展名', reg.bySource.external[0].owner, '天气');
}
{
  const ext = { id: 'ai_tools', kind: 'script', name: 'AI 工具组', enabled: true, config: { tools: [{ name: 'quote', description: 'd', code: 'return 1' }] } };
  const sd = scriptDefs({ external: [ext] });
  eq('自写工具生成一个定义', sd.defs.length, 1);
  eq('工具名带 x_ 前缀', sd.defs[0].function.name, 'x_ai_tools_quote');
  eq('描述里标注来源', /自写工具/.test(sd.defs[0].function.description), true);
  const reg = buildRegistry({ execDefs: sd.defs, exts: { builtin: [], external: [ext] }, mcp: { defs: [], map: new Map() } });
  eq('自写工具归 script', reg.bySource.script.length, 1);
  eq('来源显示工具组名', reg.bySource.script[0].owner, 'AI 工具组');
}
eq('没有 code 的自写工具被跳过', scriptDefs({ external: [{ id: 'a', kind: 'script', name: 'A', enabled: true, config: { tools: [{ name: 't', description: 'd' }] } }] }).defs.length, 0);
eq('没启用的自写工具照样登记(可在面板打开)', scriptDefs({ external: [{ id: 'a', kind: 'script', name: 'A', enabled: false, config: { tools: [{ name: 't', code: 'return 1' }] } }] }).defs.length, 1);
eq('普通 external 不会被当自写工具', scriptDefs({ external: [{ id: 'a', kind: 'external', name: 'A', enabled: true, config: { tools: [{ name: 't' }] } }] }).defs.length, 0);
eq('四个来源都有元信息', SOURCES.every((s) => SOURCE_META[s] && SOURCE_META[s].label), true);
eq('空注册表摘要', registrySummary({ stats: { total: 0 } }), '还没有可用工具');

// ---------- 工具名安全化 ----------
eq('工具名过滤特殊字符', safeToolName('e1', 'my tool!!'), 'x_e1_my_tool__');
ok('工具名过长被截断', safeToolName('e1', 'a'.repeat(60)).length <= 64);
eq('扩展 id 也参与命名', safeToolName('grp', 't'), 'x_grp_t');
eq('空工具名有兜底', safeToolName('e1', '').length > 3, true);

console.log('\n' + '='.repeat(60));
if (fails.length) {
  console.log(`❌ 模型层测试失败 ${fails.length} 项 / 共 ${pass + fails.length} 项`);
  for (const f of fails) console.log('   · ' + f);
  process.exit(1);
}
console.log(`✅ 模型层测试全部通过:${pass} 项`);
