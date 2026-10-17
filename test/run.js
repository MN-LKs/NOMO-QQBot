import { deepMerge, flatten, missingEnv, missingStorage, DEFAULT_SETTINGS, FIXED, normalizeBaseUrl, normalizeApiBase } from '../src/config.js';
import { checkCredentials, issue, verify, readCookie, cookieHeader, COOKIE } from '../src/panel/auth.js';
import { mimeFor, isTextCt, isImageCt, gzipBytes, gunzipBytes, keyFor } from '../src/store/kvfile.js';
import { quotaOf } from '../src/store/projects.js';
import { splitSitePath } from '../src/serve.js';
import { isSiteId, genSiteId, isReservedPath } from '../src/util/id.js';
import { chunkText, stripMention, toPlainText, truncate, clipMiddle } from '../src/util/text.js';
import { calc, formatNumber } from '../src/util/calc.js';
import { handleFrame, wsStatus, wsClose } from '../src/qq/gateway.js';
import { panelPage, loginPage, lockedPage } from '../src/panel/ui.js';
import { seoEnhance } from '../src/util/seo.js';
import { collectDocTargets, stripDocs } from '../tools/strip-docs.js';
import { BUILTIN_EXTS, enabledToolSet, safeToolName, externalToolDefs } from '../src/agent/exts.js';
import { pickSkills, parseSkillDoc, parseTriggers } from '../src/agent/skills.js';
import { resolveStores, availability } from '../src/store/storage.js';
import { uriEncode, sha256Hex } from '../src/store/s3.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
const fails = [];
function ok(name, cond, extra = '') {
  if (cond) pass++;
  else fails.push(`${name}${extra ? ` — ${extra}` : ''}`);
}
function eq(name, a, b) {
  ok(name, JSON.stringify(a) === JSON.stringify(b), `期望 ${JSON.stringify(b)},实际 ${JSON.stringify(a)}`);
}
function throws(name, fn) {
  try {
    fn();
    fails.push(`${name} — 没有抛错`);
  } catch {
    pass++;
  }
}

// ---------- 配置 ----------
eq('deepMerge 合并嵌套', deepMerge({ a: { b: 1, c: 2 } }, { a: { c: 3 } }), { a: { b: 1, c: 3 } });
eq('deepMerge 数组直接替换', deepMerge({ a: [1, 2] }, { a: [3] }), { a: [3] });
eq('deepMerge 空补丁不动', deepMerge({ a: 1 }, null), { a: 1 });

const env1 = { ADMIN_USER: 'admin', ADMIN_PASS: 'pw12345678' };
const cfg1 = flatten(DEFAULT_SETTINGS, env1);
eq('默认连接方式是 webhook', cfg1.mode, 'webhook');
eq('可以切回 websocket', flatten(deepMerge(DEFAULT_SETTINGS, { qq: { mode: 'websocket' } }), env1).mode, 'websocket');
eq('默认模型', cfg1.llmModel, 'deepseek-v4.1-flash');
eq('默认最多 5 个项目', cfg1.maxSites, 5);
eq('默认存活 600 秒', cfg1.siteTtlSeconds, 600);
eq('空 APPID 时 appId 为空', cfg1.appId, '');
eq('QQ_API_BASE 覆盖', flatten(DEFAULT_SETTINGS, { QQ_API_BASE: 'http://127.0.0.1:9/' }).apiBase, 'http://127.0.0.1:9');
eq('覆盖时 token 地址也跟随', flatten(DEFAULT_SETTINGS, { QQ_API_BASE: 'http://x' }).tokenUrl, 'http://x/app/getAppAccessToken');
eq('正式环境域名', cfg1.apiBase, 'https://api.sgroup.qq.com');
eq('沙箱环境域名', flatten(deepMerge(DEFAULT_SETTINGS, { qq: { sandbox: true } }), env1).apiBase, 'https://sandbox.api.sgroup.qq.com');
eq('取 token 域名固定是 bots.qq.com', cfg1.tokenUrl, 'https://bots.qq.com/app/getAppAccessToken');
eq('沙箱也走同一个 token 域名', flatten(deepMerge(DEFAULT_SETTINGS, { qq: { sandbox: true } }), env1).tokenUrl, 'https://bots.qq.com/app/getAppAccessToken');
eq('网关地址由 apiBase 推出', cfg1.gatewayUrl, 'https://api.sgroup.qq.com/websocket/');
ok('sandbox 标志透传', flatten(deepMerge(DEFAULT_SETTINGS, { qq: { sandbox: true } }), env1).sandbox === true);
ok('默认不是沙箱', cfg1.sandbox === false);
eq('缺环境变量', missingEnv({}), ['ADMIN_USER', 'ADMIN_PASS']);
eq('空白管理员变量也算缺失', missingEnv({ ADMIN_USER: '   ', ADMIN_PASS: '' }), ['ADMIN_USER', 'ADMIN_PASS']);
eq('缺 D1/KV 的提示', missingStorage({}), ['D1 数据库(DB)', 'KV 命名空间(STORE)']);
eq('只缺 KV 的提示', missingStorage({ DB: {} }), ['KV 命名空间(STORE)']);
{
  const toml = fs.readFileSync(path.join(ROOT, 'wrangler.toml'), 'utf8');
  ok('wrangler.toml 开启 keep_vars', /^keep_vars\s*=\s*true/m.test(toml));
  // 迁移期允许 [vars] 里有空值(为了让 CF 重新出现变量名),但绝不能有真实值。
  const varLines = toml.split('\n').filter((l) => /^ADMIN_(?:USER|PASS)\s*=/.test(l));
  ok('[vars] 里不能出现真实管理员值', varLines.every((l) => /=\s*""\s*$/.test(l)));
  const jsmini = fs.readFileSync(path.join(ROOT, 'test/jsmini.test.mjs'), 'utf8');
  ok('jsmini 测试没有本机绝对路径', !/['"`]\/(?:workspace|home|Users)\//.test(jsmini));
}
eq('环境变量齐全', missingEnv(env1), []);
const cfgDeep = flatten(deepMerge(DEFAULT_SETTINGS, { llm: { deepThinking: false } }), env1);
eq('关掉深度思考 → effort=none', cfgDeep.reasoningEffort, 'none');
const cfgA = flatten(DEFAULT_SETTINGS, env1);
eq('默认不限制单次请求时间', cfgA.llmTimeLimitEnabled, false);
eq('默认投递方式 auto', cfgA.answerDelivery, 'auto');
eq('默认并发 4', cfgA.agentConcurrency, 4);
eq('默认总预算无限', cfgA.agentBudgetMs, 0);
const cfgB = flatten(deepMerge(DEFAULT_SETTINGS, {
  llm: { timeLimitEnabled: true, maxSeconds: 30 },
  qq: { answerDelivery: 'active' },
  agent: { concurrency: 99, budgetSeconds: 600 },
}), env1);
ok('开启限时后生效', cfgB.llmTimeLimitEnabled === true && cfgB.llmMaxSeconds === 30);
eq('投递方式 active', cfgB.answerDelivery, 'active');
eq('并发上限夹到 10', cfgB.agentConcurrency, 10);
eq('总预算 600 秒', cfgB.agentBudgetMs, 600000);

// ---------- 工具配置(搜索条数 / 网页查询 API / 中转站面板) ----------
eq('默认搜索条数 5', cfgA.searchResults, 5);
eq('搜索条数可调', flatten(deepMerge(DEFAULT_SETTINGS, { search: { results: 8 } }), env1).searchResults, 8);
eq('搜索条数上限夹到 10', flatten(deepMerge(DEFAULT_SETTINGS, { search: { results: 99 } }), env1).searchResults, 10);
eq('搜索条数负数夹到 1', flatten(deepMerge(DEFAULT_SETTINGS, { search: { results: -3 } }), env1).searchResults, 1);
eq('搜索条数 0 回落默认', flatten(deepMerge(DEFAULT_SETTINGS, { search: { results: 0 } }), env1).searchResults, 5);
eq('搜索/读取接口默认空', cfgA.searchApiUrl, '');
eq('搜索/读取接口默认空(读取)', cfgA.readerApiUrl, '');
const cfgE = flatten(deepMerge(DEFAULT_SETTINGS, { search: { baseUrl: 'https://r.example.com/v1/' } }), env1);
eq('baseUrl 推导出搜索端点', cfgE.searchApiUrl, 'https://r.example.com/v1/search');
eq('baseUrl 推导出读取端点', cfgE.readerApiUrl, 'https://r.example.com/v1/reader');
eq('baseUrl 带 /search 后缀会剥离', flatten(deepMerge(DEFAULT_SETTINGS, { search: { baseUrl: 'https://r.example.com/v1/search' } }), env1).searchApiUrl, 'https://r.example.com/v1/search');
eq('自定义路径', flatten(deepMerge(DEFAULT_SETTINGS, { search: { baseUrl: 'https://r.example.com', searchPath: '/s', readerPath: '/r' } }), env1).readerApiUrl, 'https://r.example.com/r');
eq('读取 format 透传', flatten(deepMerge(DEFAULT_SETTINGS, { search: { readerFormat: 'json' } }), env1).searchReaderFormat, 'json');

// ---------- 地址整理(协议 / 尾斜杠 / 完整端点) ----------
eq('没写协议自动补 https', normalizeBaseUrl('api.x.com/v1/'), 'https://api.x.com/v1');
eq('协议相对地址补 https', normalizeBaseUrl('//api.x.com/v1'), 'https://api.x.com/v1');
eq('空地址保持空', normalizeBaseUrl('   '), '');
eq('只有协议没有主机名也算空', normalizeBaseUrl('https://'), '');
eq('公网 http 升级 https', normalizeBaseUrl('http://ai.example.com/', { httpsOnly: true }), 'https://ai.example.com');
eq('本机地址保留 http', normalizeBaseUrl('http://127.0.0.1:8787', { httpsOnly: true }), 'http://127.0.0.1:8787');
eq('内网地址保留 http', normalizeBaseUrl('http://192.168.1.9:8787', { httpsOnly: true }), 'http://192.168.1.9:8787');
eq('完整 chat/completions 会被剥掉', normalizeApiBase('https://api.x.com/v1/chat/completions'), 'https://api.x.com/v1');
eq('AI 地址缺协议也能用', flatten(deepMerge(DEFAULT_SETTINGS, { llm: { baseUrl: 'api.x.com/v1/' } }), env1).llmBaseUrl, 'https://api.x.com/v1');
eq('搜索地址缺协议也能推出端点', flatten(deepMerge(DEFAULT_SETTINGS, { search: { baseUrl: 'search.x.com/v1' } }), env1).searchApiUrl, 'https://search.x.com/v1/search');
eq('站点域名缺协议自动补全', flatten(deepMerge(DEFAULT_SETTINGS, { site: { publicBaseUrl: 'ai.example.com/' } }), env1).publicBaseUrl, 'https://ai.example.com');
eq('站点域名 http 升级 https', flatten(deepMerge(DEFAULT_SETTINGS, { site: { publicBaseUrl: 'http://ai.example.com' } }), env1).publicBaseUrl, 'https://ai.example.com');
eq('中转站面板默认地址', cfgA.dashboardUrl, 'https://manage.nexacode.dpdns.org/api/dashboard');
eq('中转站面板可清空', flatten(deepMerge(DEFAULT_SETTINGS, { dashboard: { url: '' } }), env1).dashboardUrl, '');

// ---------- 扩展 / 技能 / 存储 ----------
const tset = enabledToolSet({ builtin: BUILTIN_EXTS.map((b) => ({ ...b, enabled: true })), external: [] });
ok('内置扩展含会话记忆', ['remember', 'recall', 'forget'].every((t) => tset.has(t)));
ok('内置扩展含群聊工具', tset.has('group_recent') && tset.has('group_find'));
ok('内置扩展含基础工具', ['calc', 'now', 'web_search', 'fetch_url', 'random', 'encode', 'query_dashboard'].every((t) => tset.has(t)));
ok('关掉一个扩展后其工具消失', !enabledToolSet({ builtin: [{ id: 'dice', tools: ['random'], enabled: false }] }).has('random'));
eq('外置工具名会加前缀并清洗', safeToolName('my ext', 'do.thing'), 'x_my_ext_do_thing');
const exDefs = externalToolDefs({ external: [{ id: 'e1', name: 'E', enabled: true, config: { tools: [{ name: 'ping', endpoint: 'https://x/y' }] } }] });
eq('外置扩展生成工具定义', exDefs.defs.length, 1);
ok('外置扩展查找表可用', exDefs.map.has(exDefs.defs[0].function.name));
eq('技能触发词解析', parseTriggers('甲, 乙 丙'), ['甲', '乙', '丙']);
eq('触发词命中才注入', pickSkills([{ name: 'A', content: 'aaa', enabled: true, triggers: ['菠萝'] }], '菠萝好吃吗', 6000).length, 1);
eq('触发词不命中不注入', pickSkills([{ name: 'A', content: 'aaa', enabled: true, triggers: ['菠萝'] }], '苹果好吃吗', 6000).length, 0);
eq('无触发词=总是注入', pickSkills([{ name: 'A', content: 'aaa', enabled: true, triggers: [] }], '随便', 6000).length, 1);
const skillDoc = parseSkillDoc('---\nname: 测试\ndescription: 说明\ntriggers: x, y\n---\n正文内容');
eq('SKILL.md frontmatter 解析', [skillDoc.name, skillDoc.description, skillDoc.triggers.join('|'), skillDoc.content], ['测试', '说明', 'x|y', '正文内容']);
const rs = resolveStores({ storage: { stores: [] } }, { R2: {}, STORE: {} });
eq('自动识别 R2 与 KV', rs.map((s) => s.id), ['r2', 'kv']);
ok('R2 默认优先级更高', rs[0].priority > rs[1].priority);
ok('R2 绑定可用', availability({ R2: {} }, rs[0]).ok);
ok('绑定缺失时不可用', !availability({}, rs[0]).ok);
eq('URI 编码保留斜杠选项', [uriEncode('a b/c', false), uriEncode('a b/c', true)], ['a%20b%2Fc', 'a%20b/c']);
eq('sha256 已知向量', await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');

// ---------- 登录鉴权 ----------
ok('密码正确', checkCredentials(env1, 'admin', 'pw12345678'));
ok('密码错误', !checkCredentials(env1, 'admin', 'pw12345679'));
ok('用户名错误', !checkCredentials(env1, 'admin2', 'pw12345678'));
ok('空密码不放行', !checkCredentials({ ADMIN_USER: 'a', ADMIN_PASS: '' }, 'a', ''));
ok('长度不同也不崩', !checkCredentials(env1, 'admin', 'short'));

const token = await issue(env1);
ok('会话令牌可验证', await verify(env1, token));
ok('换密码后旧令牌失效', !(await verify({ ADMIN_USER: 'admin', ADMIN_PASS: 'other' }, token)));
ok('篡改令牌无效', !(await verify(env1, `${token}x`)));
ok('空令牌无效', !(await verify(env1, '')));
const cookie = cookieHeader(token, 100);
ok('Cookie 带 HttpOnly', cookie.includes('HttpOnly'));
ok('Cookie 带 SameSite=Strict', cookie.includes('SameSite=Strict'));
eq('读取 Cookie', readCookie(new Request('https://x/', { headers: { Cookie: `a=1; ${COOKIE}=abc.def; b=2` } })), 'abc.def');
eq('没有 Cookie 返回空', readCookie(new Request('https://x/')), '');

// ---------- 文件与压缩 ----------
eq('html 的 mime', mimeFor('index.html'), 'text/html; charset=utf-8');
eq('未知扩展名', mimeFor('a.bin'), 'application/octet-stream');
ok('text/html 算文本', isTextCt('text/html; charset=utf-8'));
ok('image/png 不算文本', !isTextCt('image/png'));
ok('png 是图片', isImageCt('image/png'));
ok('svg 不算位图', !isImageCt('image/svg+xml'));
eq('KV 键前缀', keyFor('ab12cd34', '/index.html'), 'f/ab12cd34/index.html');

const raw = new TextEncoder().encode('<html>'.repeat(200));
const gz = await gzipBytes(raw);
ok('gzip 后更小', gz.byteLength < raw.byteLength, `${gz.byteLength} vs ${raw.byteLength}`);
const back = await gunzipBytes(gz);
ok('解压后内容一致', new TextDecoder().decode(back) === new TextDecoder().decode(raw));

// ---------- 配额 ----------
const q = quotaOf(DEFAULT_SETTINGS);
eq('KV 总容量 1GB', q.total, 1024 * 1024 * 1024);
eq('每项目保底 64MB', q.per, 64 * 1024 * 1024);
eq('保留区 64MB', q.reserve, 64 * 1024 * 1024);
eq('容量上限 15 个', q.capacity, 15);
eq('默认 5 个不触发压缩', q.maxProjects, 5);
eq('动态池 = 总 - 保留 - 5×64MB', q.dynamic, 1024 * 1024 * 1024 - 64 * 1024 * 1024 - 5 * 64 * 1024 * 1024);
const qBig = quotaOf(deepMerge(DEFAULT_SETTINGS, { deploy: { maxProjects: 99 } }));
ok('超过容量会被夹住', qBig.clamped && qBig.maxProjects === 15);
const qSmall = quotaOf(deepMerge(DEFAULT_SETTINGS, { deploy: { maxProjects: 0 } }));
eq('至少 1 个', qSmall.maxProjects, 1);

// ---------- 路径 ----------
eq('拆站点路径', splitSitePath('/ab12cd34'), { id: 'ab12cd34', rest: '' });
eq('拆子文件', splitSitePath('/ab12cd34/css/a.css'), { id: 'ab12cd34', rest: 'css/a.css' });
eq('根路径', splitSitePath('/'), { id: '', rest: '' });
eq('中文 ID 还原', splitSitePath('/%E4%BA%91%E6%98%9F%E6%99%BA%E5%88%9B'), { id: '云星智创', rest: '' });
eq('中文子路径还原', splitSitePath('/ab12cd34/%E6%96%87%E4%BB%B6.html'), { id: 'ab12cd34', rest: '文件.html' });
eq('坏编码不抛错', splitSitePath('/ab%zz'), { id: 'ab%zz', rest: '' });

// ---------- 站点 ID 校验 ----------
ok('合法 ID:纯 ASCII', isSiteId('ab12cd34'));
ok('合法 ID:纯汉字', isSiteId('云星智创'));
ok('合法 ID:混合', isSiteId('ab云星cd'));
ok('非法 ID:含点(扫描器)', !isSiteId('env.dev'));
ok('非法 ID:太短', !isSiteId('env'));
ok('非法 ID:太长', !isSiteId('abcdefghijklmnopqrstuvwx12345'));
ok('非法 ID:大写', !isSiteId('ABCD1234'));
ok('非法 ID:空', !isSiteId(''));

// ---------- 站点 ID 生成(部署用,默认 ascii) ----------
const gA = genSiteId(8, 'ascii');
ok('ascii ID 形状正确', /^[a-z0-9]{8}$/.test(gA), gA);
ok('ascii ID 不含易混字符 i/l/o/0/1', !/[ilo01]/.test(gA), gA);
ok('ascii ID 通过 isSiteId', isSiteId(gA), gA);
const gC = genSiteId(8, 'cjk');
ok('cjk ID 含汉字', /[\u4e00-\u9fff]/.test(gC), gC);
ok('cjk ID 通过 isSiteId', isSiteId(gC), gC);
eq('长度夹取:太短至少 4', genSiteId(1, 'ascii').length, 4);
eq('长度夹取:太长最多 24', genSiteId(99, 'ascii').length, 24);
ok('保留字会被识别', isReservedPath('index') && isReservedPath('test'));

// ---------- 文本 ----------
eq('truncate 结果不超过上限', truncate('abcdef', 3), 'ab…');
eq('truncate 短的不动', truncate('ab', 10), 'ab');
ok('clipMiddle 短文本不动', clipMiddle('abc', 10, 5) === 'abc');
const clipped = clipMiddle('a'.repeat(5000), 100, 50);
ok('clipMiddle 保留头尾并折叠中间', clipped.startsWith('a'.repeat(100)) && clipped.endsWith('a'.repeat(50)) && clipped.includes('中间省略 4850 字'));
ok('chunkText 分片', chunkText('a'.repeat(2000), 800, 5).length === 3);
ok('chunkText 上限', chunkText('a'.repeat(9000), 800, 5).length === 5);
ok('toPlainText 去 Markdown', !toPlainText('**粗**').includes('**'));
eq('stripMention 去掉 @机器人', stripMention('<@1DE88C976BC91D0206BAEB85C5213F0C> /AI 你好'), '/AI 你好');
eq('stripMention 去掉 <@!...>', stripMention('<@!123> /帮助'), '/帮助');
eq('stripMention 不动正文里的 @', stripMention('/AI 说 <@123> 是谁'), '/AI 说 <@123> 是谁');

// ---------- 计算与编码 ----------
eq('calc 四则', formatNumber(calc('(17*23+5)/4')), '99');
ok('calc 函数', Math.abs(calc('sqrt(2)*10') - 14.1421356) < 0.001);
throws('calc 拒绝非法表达式', () => calc('alert(1)'));

// ---------- WebSocket 帧处理 ----------
function fakeCore() {
  const sent = [];
  const core = {
    env: {},
    wsState: 'open',
    ws: { send: (s) => sent.push(JSON.parse(s)), close: () => {} },
    queue: [],
    reconnect: 0,
    enqueue(t) { this.queue.push(t); return { ok: true }; },
    async cfg() { return { appId: '100', appSecret: 'x', intents: 33554432 }; },
    async getToken() { return 'tok123'; },
    scheduleReconnect(ms) { this.reconnect = ms; },
    async onJoin() {},
  };
  core.sent = sent;
  return core;
}
{
  const core = fakeCore();
  await handleFrame(core, { op: 10, d: { heartbeat_interval: 30000 } });
  ok('HELLO 后发了心跳', core.sent.some((f) => f.op === 1));
  const id = core.sent.find((f) => f.op === 2);
  ok('HELLO 后发了 Identify', !!id);
  eq('Identify token 带 QQBot 前缀', id?.d?.token, 'QQBot tok123');
  eq('Identify 带 intents', id?.d?.intents, 33554432);
  wsClose(core);
  ok('关闭后状态是 stopped', core.wsState === 'stopped');
}
{
  const core = fakeCore();
  await handleFrame(core, { op: 0, s: 7, t: 'GROUP_AT_MESSAGE_CREATE', d: { id: 'm1', content: '你好', group_openid: 'g1', author: { member_openid: 'u1', nickname: '小明' } } });
  eq('消息事件已入队', core.queue.length, 1);
  eq('入队的是消息类型', core.queue[0].kind, 'message');
  eq('会话 ID 是群维度', core.queue[0].convId, 'g:g1');
  eq('记录 seq', core.wsSeq, 7);
}
{
  const core = fakeCore();
  let joined = null;
  core.onJoin = async (t) => { joined = t; };
  await handleFrame(core, { op: 0, t: 'GROUP_ADD_ROBOT', d: { group_openid: 'g9' } });
  eq('加群事件入队欢迎语', core.queue.length, 1);
  eq('欢迎语是帮助文本', core.queue[0].text, '/帮助');
  ok('加群事件触发 onJoin', joined && joined.targetId === 'g9');
}
{
  const core = fakeCore();
  await handleFrame(core, { op: 7 });
  ok('op=7 触发重连', core.reconnect > 0);
  eq('状态标记为 reconnecting', core.wsState, 'reconnecting');
}
{
  const core = fakeCore();
  const st = wsStatus(core);
  ok('状态对象有 connected 字段', 'connected' in st && 'reconnects' in st);
}

// ---------- 面板前端脚本 ----------
// 前端整段代码是塞在模板字符串里的,反斜杠会被吃掉一层、少一个 </script> 就整页崩,
// 所以这里把脚本抽出来真的做一次语法检查。
function extractScripts(html) {
  const out = [];
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out.join('\n;\n');
}
{
  const panel = panelPage({ user: 'admin' });
  eq('面板 HTML 只有一段脚本', (panel.match(/<script>/g) || []).length, 1);
  eq('面板 HTML 只有一个结束标签', (panel.match(/<\/script>/g) || []).length, 1);
  ok('正则里的反斜杠没有被模板字符串吃掉', extractScripts(panel).includes('/^#\\/?/'));
  ok('换行转义还在', extractScripts(panel).includes("join('\\n')"));
  for (const [name, code] of [['panel', extractScripts(panel)], ['login', extractScripts(loginPage({}))]]) {
    const f = `/tmp/nomo-ui-${name}.js`;
    fs.writeFileSync(f, code);
    try {
      execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
      pass++;
    } catch (e) {
      fails.push(`前端脚本 ${name} 语法错误:${String(e.stderr || e.message).slice(0, 200)}`);
    }
  }
}

// ---------- 面板锁定 / SEO 兜底 / 描述文件清理 ----------
{
  const locked = lockedPage();
  ok('缺管理员时面板显示「登录功能已关闭」', locked.includes('登录功能已关闭'));
  ok('锁定页不再显示登录表单', !locked.includes('请登录以继续'));
  ok('锁定页带 noindex', locked.includes('noindex'));
}
{
  const full = '<!DOCTYPE html><html><head><title>小游戏</title></head><body>x</body></html>';
  const out = seoEnhance(full, { name: '2048', description: '一个 2048 小游戏', url: 'https://ai.example.com/abcd1234' });
  ok('补 meta description', out.includes('<meta name="description" content="一个 2048 小游戏">'));
  ok('补 charset', out.includes('<meta charset="utf-8">'));
  ok('补 canonical', out.includes('<link rel="canonical" href="https://ai.example.com/abcd1234">'));
  ok('补 Open Graph', out.includes('property="og:title"') && out.includes('property="og:description"') && out.includes('property="og:url"'));
  ok('补 Twitter Card', out.includes('name="twitter:card"') && out.includes('name="twitter:title"'));
  ok('补 theme-color', out.includes('name="theme-color"'));
  ok('补 favicon', out.includes('rel="icon"') && out.includes('data:image/svg+xml'));
  ok('补 JSON-LD', out.includes('application/ld+json') && out.includes('"@type":"WebPage"') && out.includes('"@type":"WebSite"'));
  ok('JSON-LD 带 url', out.includes('https://ai.example.com/abcd1234'));
  ok('补 lang', out.includes('lang="zh-CN"'));
  ok('补 viewport', out.includes('name="viewport"'));
  ok('不重复补 title', (out.match(/<title>/g) || []).length === 1);
  ok('不重复补 charset', (out.match(/charset=/g) || []).length === 1);
  ok('不重复补 description', (out.match(/name="description"/g) || []).length === 1);

  const custom = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="description" content="我自己写的"><meta property="og:title" content="我的 OG"><link rel="canonical" href="https://x.example/y"><script type="application/ld+json">{}</script></head><body></body></html>';
  const out2 = seoEnhance(custom, { name: 'x', description: '默认描述', url: 'https://ai.example.com/z' });
  ok('已有 description 不覆盖', out2.includes('<meta name="description" content="我自己写的">') && !out2.includes('<meta name="description" content="默认描述">'));
  ok('已有 OG 不覆盖', (out2.match(/property="og:title"/g) || []).length === 1 && out2.includes('content="我的 OG"'));
  ok('已有 canonical 不覆盖', (out2.match(/rel="canonical"/g) || []).length === 1 && out2.includes('href="https://x.example/y"'));
  ok('已有 JSON-LD 不重复', (out2.match(/application\/ld\+json/g) || []).length === 1);
  ok('已有 lang 不改', out2.includes('lang="en"'));

  const empty = '<html><head><title> </title><meta name="description" content=""><link rel="canonical" href=""></head><body></body></html>';
  const out3 = seoEnhance(empty, { name: '空字段', description: '默认描述', url: 'https://ai.example.com/e' });
  ok('空 title 用默认值替换', out3.includes('<title>空字段</title>'));
  ok('空 description 用默认值替换', out3.includes('content="默认描述"'));
  ok('空 canonical 用默认值替换', out3.includes('href="https://ai.example.com/e"'));

  const bare = '<html><body>hi</body></html>';
  const out4 = seoEnhance(bare, { name: '裸页面' });
  ok('没有 head 时自动补一个', out4.includes('<head>') && out4.includes('</head>'));
  ok('裸页面也能拿到标题', out4.includes('<title>裸页面</title>'));
  ok('裸页面补 doctype', out4.startsWith('<!DOCTYPE html>'));

  const frag = '<h1>片段</h1>';
  const out5 = seoEnhance(frag, { name: 'x' });
  ok('裸片段会包成完整文档', out5.startsWith('<!DOCTYPE html>') && out5.includes('<head>') && out5.includes('<h1>片段</h1>'));

  const evil = seoEnhance('<html><head></head><body></body></html>', { name: '</script><script>alert(1)</script>' });
  ok('JSON-LD 里转义 <', !evil.includes('</script><script>alert(1)'));
}
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nomo-docs-'));
  fs.mkdirSync(path.join(tmp, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'README.md'), '# hi');
  fs.writeFileSync(path.join(tmp, 'docs', 'FAQ.md'), '# qa');
  fs.writeFileSync(path.join(tmp, 'src', 'notes.md'), '# notes');
  fs.writeFileSync(path.join(tmp, 'src', 'app.js'), 'export const a = 1;');
  fs.writeFileSync(path.join(tmp, 'node_modules', 'dep', 'README.md'), '# dep');
  const targets = collectDocTargets(tmp);
  ok('收集到根 README', targets.files.some((f) => f.endsWith('README.md')));
  ok('收集到子目录 md', targets.files.some((f) => f.endsWith('notes.md')));
  ok('docs 目录整体作为目标', targets.dirs.some((d) => d.endsWith('docs')));
  ok('不碰 node_modules', !targets.files.some((f) => f.includes('node_modules')));
  const dry = stripDocs(tmp, { force: false });
  ok('未授权时不动文件', dry.skipped === true && fs.existsSync(path.join(tmp, 'README.md')));
  const run = stripDocs(tmp, { force: true });
  ok('授权后删除 md 与 docs', !fs.existsSync(path.join(tmp, 'README.md')) && !fs.existsSync(path.join(tmp, 'docs')));
  ok('子目录 md 也删掉', !fs.existsSync(path.join(tmp, 'src', 'notes.md')));
  ok('业务代码保留', fs.existsSync(path.join(tmp, 'src', 'app.js')));
  ok('node_modules 保留', fs.existsSync(path.join(tmp, 'node_modules', 'dep', 'README.md')));
  ok('返回被删除的清单', run.removed.length >= 3);
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${'='.repeat(60)}`);
if (fails.length) {
  console.log(`❌ 单元测试失败 ${fails.length} 项 / 共 ${pass + fails.length} 项`);
  for (const f of fails) console.log(`   · ${f}`);
  process.exit(1);
}
console.log(`✅ 全部通过:${pass} 项`);
