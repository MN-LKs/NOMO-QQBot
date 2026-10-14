import { deepMerge, flatten, missingEnv, DEFAULT_SETTINGS, FIXED } from '../src/config.js';
import { checkCredentials, issue, verify, readCookie, cookieHeader, COOKIE } from '../src/panel/auth.js';
import { mimeFor, isTextCt, isImageCt, gzipBytes, gunzipBytes, keyFor } from '../src/store/kvfile.js';
import { quotaOf } from '../src/store/projects.js';
import { splitSitePath } from '../src/serve.js';
import { chunkText, toPlainText, truncate } from '../src/util/text.js';
import { calc, formatNumber } from '../src/util/calc.js';
import { handleFrame, wsStatus, wsClose } from '../src/qq/gateway.js';
import { panelPage, loginPage } from '../src/panel/ui.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

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
eq('默认连接方式是 websocket', cfg1.mode, 'websocket');
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
eq('环境变量齐全', missingEnv(env1), []);
const cfgDeep = flatten(deepMerge(DEFAULT_SETTINGS, { llm: { deepThinking: false } }), env1);
eq('关掉深度思考 → effort=none', cfgDeep.reasoningEffort, 'none');

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

// ---------- 文本 ----------
eq('truncate 结果不超过上限', truncate('abcdef', 3), 'ab…');
eq('truncate 短的不动', truncate('ab', 10), 'ab');
ok('chunkText 分片', chunkText('a'.repeat(2000), 800, 5).length === 3);
ok('chunkText 上限', chunkText('a'.repeat(9000), 800, 5).length === 5);
ok('toPlainText 去 Markdown', !toPlainText('**粗**').includes('**'));

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
    const f = `/tmp/npapi-ui-${name}.js`;
    fs.writeFileSync(f, code);
    try {
      execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
      pass++;
    } catch (e) {
      fails.push(`前端脚本 ${name} 语法错误:${String(e.stderr || e.message).slice(0, 200)}`);
    }
  }
}

console.log(`\n${'='.repeat(60)}`);
if (fails.length) {
  console.log(`❌ 单元测试失败 ${fails.length} 项 / 共 ${pass + fails.length} 项`);
  for (const f of fails) console.log(`   · ${f}`);
  process.exit(1);
}
console.log(`✅ 全部通过:${pass} 项`);
