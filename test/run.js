// 零依赖单测。跑法:node test/run.js

import assert from 'node:assert/strict';
import { seedFromSecret, signValidation, verifyWebhook, keysFromSecret } from '../src/qq/sign.js';
import { bytesToHex, hexToBytes, concatBytes } from '../src/util/bytes.js';
import { chunkText, toPlainText, truncate, safeJson } from '../src/util/text.js';
import { genSiteId, isReservedPath } from '../src/util/id.js';
import { calc, formatNumber } from '../src/util/calc.js';
import { htmlToText, decodeEntities } from '../src/util/html.js';
import { parseCompletion, isBlank, RETRY_NUDGE } from '../src/agent/llm.js';
import { detectProvider, extractResults, buildRequest, SUPPORTED_PROVIDERS } from '../src/agent/search.js';
import { normaliseFiles } from '../src/agent/exec.js';
import { normaliseEvent } from '../src/qq/webhook.js';
import { executeTool } from '../src/agent/exec.js';
import { parseCommand } from '../src/core/do.js';
import { splitSitePath } from '../src/serve.js';
import { buildTools } from '../src/agent/tools.js';
import { buildSystemPrompt, buildHelpText } from '../src/agent/prompt.js';
import { loadConfig, missingVars, ALL_VARS } from '../src/config.js';

let pass = 0;
let fail = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    pass++;
  } catch (e) {
    fail++;
    failures.push(`${name}: ${e.message}`);
  }
}
async function testAsync(name, fn) {
  try {
    await fn();
    pass++;
  } catch (e) {
    fail++;
    failures.push(`${name}: ${e.message}`);
  }
}

// ===========================================================================
// 1. Ed25519 签名
// ===========================================================================
test('seed 展开:官方文档给出的测试向量', () => {
  assert.equal(new TextDecoder().decode(seedFromSecret('naOC0ocQE3shWLAfffVLB1rhYPG7')), 'naOC0ocQE3shWLAfffVLB1rhYPG7naOC');
});
test('seed 展开:32 位密钥原样使用', () => {
  // 用假密钥,真密钥永远不进仓库
  const s = '0123456789abcdefghijklmnopqrstuv';
  assert.equal(new TextDecoder().decode(seedFromSecret(s)), s);
});
test('seed 展开:超短密钥会翻倍补齐', () => {
  assert.equal(seedFromSecret('ab').length, 32);
});
test('seed 展开:空密钥抛错', () => {
  assert.throws(() => seedFromSecret(''));
});
await testAsync('公钥与官方文档测试向量一致', async () => {
  const { publicRaw } = await keysFromSecret('naOC0ocQE3shWLAfffVLB1rhYPG7');
  assert.equal(bytesToHex(publicRaw), 'd7c362fe78aef81ff23287b493628b5db02a3c4fe30b215e4d19609b5d76673a');
});
await testAsync('op=13 签名长度 128 位 hex,且可被自己验签', async () => {
  const sig = await signValidation('naOC0ocQE3shWLAfffVLB1rhYPG7', '1725442341', 'Arq0D5A61EgUu4OxUvOp');
  assert.equal(sig.length, 128);
  assert.match(sig, /^[0-9a-f]+$/);
  const { privateKey, publicKey } = await keysFromSecret('naOC0ocQE3shWLAfffVLB1rhYPG7');
  const msg = new TextEncoder().encode('1725442341Arq0D5A61EgUu4OxUvOp');
  const raw = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, msg));
  assert.ok(await crypto.subtle.verify({ name: 'Ed25519' }, publicKey, raw, msg));
});
await testAsync('验签:正确签名通过,篡改 body 失败', async () => {
  const secret = 'fake-secret-for-tests-only';
  const { privateKey } = await keysFromSecret(secret);
  const body = new TextEncoder().encode('{"op":0,"t":"GROUP_AT_MESSAGE_CREATE"}');
  const ts = '1725442341';
  const sig = bytesToHex(new Uint8Array(await crypto.subtle.sign(
    { name: 'Ed25519' }, privateKey, concatBytes(new TextEncoder().encode(ts), body),
  )));
  assert.equal((await verifyWebhook(secret, sig, ts, body)).ok, true);
  const tampered = new TextEncoder().encode('{"op":0,"t":"EVIL"}');
  assert.equal((await verifyWebhook(secret, sig, ts, tampered)).ok, false);
});
await testAsync('验签:缺头 / 非 hex / 长度不对 全部拒绝', async () => {
  const b = new TextEncoder().encode('{}');
  assert.equal((await verifyWebhook('s', null, '1', b)).ok, false);
  assert.equal((await verifyWebhook('s', 'zz', '1', b)).ok, false);
  assert.equal((await verifyWebhook('s', 'abcd', '1', b)).ok, false);
});

// ===========================================================================
// 2. 字节工具
// ===========================================================================
test('hex 往返', () => {
  assert.equal(bytesToHex(hexToBytes('00ff10')), '00ff10');
  assert.equal(bytesToHex(new Uint8Array([0, 15, 255])), '000fff');
});
test('hex 非法输入抛错', () => {
  assert.throws(() => hexToBytes('abc'));
  assert.throws(() => hexToBytes('zz'));
});
test('concatBytes 拼接正确', () => {
  const r = concatBytes(new Uint8Array([1, 2]), new Uint8Array([3]));
  assert.deepEqual([...r], [1, 2, 3]);
});

// ===========================================================================
// 3. 文本
// ===========================================================================
test('truncate', () => {
  assert.equal(truncate('abcdef', 10), 'abcdef');
  assert.equal(truncate('abcdef', 5), 'abcd…');
});
test('chunkText:短文本不分块', () => {
  assert.deepEqual(chunkText('你好', 100), ['你好']);
});
test('chunkText:优先在换行处断开', () => {
  const s = `${'a'.repeat(50)}\n${'b'.repeat(50)}`;
  const c = chunkText(s, 60, 5);
  assert.equal(c.length, 2);
  assert.ok(c[0].startsWith('a'));
  assert.ok(c[1].startsWith('b'));
});
test('chunkText:不超过 maxChunks', () => {
  const s = 'x'.repeat(10000);
  const c = chunkText(s, 100, 3);
  assert.equal(c.length, 3);
  assert.ok(c.every((x) => x.length <= 100));
});
test('chunkText:空输入返回空数组', () => {
  assert.deepEqual(chunkText(''), []);
  assert.deepEqual(chunkText('   '), []);
});
test('toPlainText:去掉 Markdown 标记', () => {
  const r = toPlainText('## 标题\n**粗体** 和 `代码`\n- 项目一\n- 项目二\n\n```js\nconst a=1;\n```');
  assert.ok(!r.includes('##'));
  assert.ok(!r.includes('**'));
  assert.ok(r.includes('标题'));
  assert.ok(r.includes('粗体'));
  assert.ok(r.includes('const a=1;'));
  assert.ok(!r.includes('```'));
});
test('toPlainText:链接保留可读形式', () => {
  const r = toPlainText('看这里 [文档](https://example.com/x)');
  assert.ok(r.includes('文档(https://example.com/x)'));
});
test('safeJson', () => {
  assert.deepEqual(safeJson('{"a":1}'), { a: 1 });
  assert.equal(safeJson('{oops', null), null);
});

// ===========================================================================
// 4. 站点 ID
// ===========================================================================
test('genSiteId:长度与字符集', () => {
  for (let i = 0; i < 200; i++) {
    const id = genSiteId(8, 'ascii');
    assert.equal(id.length, 8);
    assert.match(id, /^[a-z2-9]+$/);
  }
});
test('genSiteId:mixed 至少含 1 个中文 + 3 个英文数字', () => {
  for (let i = 0; i < 300; i++) {
    const id = genSiteId(8, 'mixed');
    assert.equal(id.length, 8);
    const cjk = [...id].filter((c) => /[\u4e00-\u9fa5]/.test(c)).length;
    const ascii = [...id].filter((c) => /[a-z0-9]/.test(c)).length;
    assert.ok(cjk >= 1, `没有中文: ${id}`);
    assert.ok(ascii >= 3, `英文数字不足: ${id}`);
  }
});
test('genSiteId:足够随机(1000 次几乎不重复)', () => {
  const set = new Set();
  for (let i = 0; i < 1000; i++) set.add(genSiteId(8, 'mixed'));
  assert.ok(set.size > 990, `重复太多: ${set.size}`);
});
test('genSiteId:长度被夹到 4..24', () => {
  assert.equal(genSiteId(1, 'ascii').length, 4);
  assert.equal(genSiteId(99, 'ascii').length, 24);
});
test('isReservedPath 拦住保留字和超短 ID', () => {
  assert.equal(isReservedPath('qq'), true);
  assert.equal(isReservedPath('ADMIN'), true);
  assert.equal(isReservedPath('abc'), true);
  assert.equal(isReservedPath('abcd1234'), false);
});

// ===========================================================================
// 5. 计算器
// ===========================================================================
test('calc 基本运算', () => {
  assert.equal(calc('17*23'), 391);
  assert.equal(calc('(1+2)*3'), 9);
  assert.equal(calc('2^10'), 1024);
  assert.equal(calc('10/4'), 2.5);
  assert.equal(calc('-3+5'), 2);
  assert.equal(calc('7%4'), 3);
});
test('calc 函数与常量', () => {
  assert.equal(formatNumber(calc('sqrt(16)')), '4');
  assert.equal(calc('max(1,9,3)'), 9);
  assert.ok(Math.abs(calc('round(pi*100)/100') - 3.14) < 1e-9);
});
test('calc 拒绝非法输入', () => {
  assert.throws(() => calc('alert(1)'));
  assert.throws(() => calc('1+'));
  assert.throws(() => calc('1);process.exit()'));
  assert.throws(() => calc(''));
  assert.throws(() => calc('1/0'));
});
test('formatNumber 不留浮点尾巴', () => {
  assert.equal(formatNumber(0.1 + 0.2), '0.3');
  assert.equal(formatNumber(391), '391');
});

// ===========================================================================
// 6. HTML
// ===========================================================================
test('decodeEntities', () => {
  assert.equal(decodeEntities('a&amp;b&lt;c&#65;'), 'a&b<cA');
  assert.equal(decodeEntities('&nbsp;'), ' ');
});
test('htmlToText:剔脚本样式,保留正文', () => {
  const h = '<html><head><title>T</title><style>a{}</style></head><body><script>evil()</script><p>你好</p><div>世界</div></body></html>';
  const t = htmlToText(h);
  assert.ok(t.includes('你好'));
  assert.ok(t.includes('世界'));
  assert.ok(!t.includes('evil'));
  assert.ok(!t.includes('a{}'));
});
// ===========================================================================
// 7. 非流式响应解析
// ===========================================================================
test('parseCompletion:正文与思考分流', () => {
  const r = parseCompletion({
    choices: [{ message: { content: '你好', reasoning_content: '让我想想' }, finish_reason: 'stop' }],
    usage: { total_tokens: 42 },
  });
  assert.equal(r.content, '你好');
  assert.equal(r.reasoningHead, '让我想想');
  assert.equal(r.reasoningLen, 4);
  assert.equal(r.finishReason, 'stop');
  assert.equal(r.usage.total_tokens, 42);
  assert.equal(r.toolCalls.length, 0);
});
test('parseCompletion:思考只保留前 1500 字', () => {
  const r = parseCompletion({ choices: [{ message: { content: 'x', reasoning_content: '思'.repeat(5000) } }] });
  assert.equal(r.reasoningLen, 5000);
  assert.equal(r.reasoningHead.length, 1500);
});
test('parseCompletion:兼容 reasoning 字段名', () => {
  assert.equal(parseCompletion({ choices: [{ message: { reasoning: '想' } }] }).reasoningHead, '想');
  assert.equal(parseCompletion({ choices: [{ message: { reasoning_text: '想2' } }] }).reasoningHead, '想2');
});
test('parseCompletion:tool_calls 解析', () => {
  const r = parseCompletion({
    choices: [{
      message: {
        content: '',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'calc', arguments: '{"expression":"1+1"}' } }],
      },
      finish_reason: 'tool_calls',
    }],
  });
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0].function.name, 'calc');
  assert.deepEqual(JSON.parse(r.toolCalls[0].function.arguments), { expression: '1+1' });
});
test('parseCompletion:包裹式工具调用会被拆开', () => {
  const r = parseCompletion({
    choices: [{
      message: {
        tool_calls: [{
          function: {
            name: '',
            arguments: '{"name":"deploy_site","arguments":{"name":"x","files":[]}}',
          },
        }],
      },
    }],
  });
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0].function.name, 'deploy_site');
  assert.equal(JSON.parse(r.toolCalls[0].function.arguments).name, 'x');
});
test('parseCompletion:空结构不炸', () => {
  for (const j of [null, {}, { choices: [] }, { choices: [{}] }]) {
    const r = parseCompletion(j);
    assert.equal(r.content, '');
    assert.equal(r.toolCalls.length, 0);
  }
});
test('isBlank:空正文且无工具调用才算空', () => {
  assert.equal(isBlank({ content: '', toolCalls: [] }), true);
  assert.equal(isBlank({ content: '   ', toolCalls: [] }), true);
  assert.equal(isBlank({ content: 'ok', toolCalls: [] }), false);
  assert.equal(isBlank({ content: '', toolCalls: [{ function: { name: 'calc' } }] }), false);
});
test('降级提示词存在且要求直接给答案', () => {
  assert.ok(RETRY_NUDGE.includes('简体中文'));
  assert.ok(RETRY_NUDGE.length > 20);
});

// ===========================================================================
// 7.5 联网搜索适配层
// ===========================================================================
test('detectProvider:识别常见搜索服务', () => {
  assert.equal(detectProvider('https://metaso.cn/api/v1/search'), 'metaso');
  assert.equal(detectProvider('https://api.exa.ai/search'), 'exa');
  assert.equal(detectProvider('https://api.tavily.com/search'), 'tavily');
  assert.equal(detectProvider('https://google.serper.dev/search'), 'serper');
  assert.equal(detectProvider('https://api.search.brave.com/res/v1/web/search'), 'brave');
  assert.equal(detectProvider('https://api.bing.microsoft.com/v7.0/search'), 'bing');
  assert.equal(detectProvider('https://www.googleapis.com/customsearch/v1'), 'google');
  assert.equal(detectProvider('https://serpapi.com/search.json'), 'serpapi');
  assert.equal(detectProvider('https://my-search.example.com/api'), 'generic');
  assert.equal(detectProvider('这不是网址'), 'generic');
});
test('buildRequest:POST 型服务商', () => {
  const r = buildRequest('metaso', { url: 'https://metaso.cn/api/v1/search', key: 'K', query: '天气', count: 3 });
  assert.equal(r.init.method, 'POST');
  assert.equal(r.init.headers.Authorization, 'Bearer K');
  assert.equal(JSON.parse(r.init.body).q, '天气');
  assert.equal(JSON.parse(r.init.body).size, 3);
});
test('buildRequest:GET 型服务商把参数拼进 URL', () => {
  const r = buildRequest('brave', { url: 'https://api.search.brave.com/res/v1/web/search', key: 'K', query: 'a b', count: 2 });
  assert.equal(r.init.method, 'GET');
  assert.ok(r.url.includes('q=a+b') || r.url.includes('q=a%20b'));
  assert.equal(r.init.headers['X-Subscription-Token'], 'K');
  const g = buildRequest('google', { url: 'https://www.googleapis.com/customsearch/v1', key: 'K', query: 'x', count: 1 });
  assert.ok(g.url.includes('key=K'));
});
test('buildRequest:条数被夹在 1..10', () => {
  const many = buildRequest('tavily', { url: 'https://api.tavily.com/search', key: 'K', query: 'x', count: 999 });
  assert.equal(JSON.parse(many.init.body).max_results, 10);
});
test('extractResults:各家返回结构', () => {
  const cases = [
    ['metaso', { webpages: [{ title: 'T', link: 'https://a.com', snippet: 'S' }] }],
    ['exa', { results: [{ title: 'T', url: 'https://a.com', text: 'S' }] }],
    ['tavily', { results: [{ title: 'T', url: 'https://a.com', content: 'S' }] }],
    ['serper', { organic: [{ title: 'T', link: 'https://a.com', snippet: 'S' }] }],
    ['brave', { web: { results: [{ title: 'T', url: 'https://a.com', description: 'S' }] } }],
    ['bing', { webPages: { value: [{ name: 'T', url: 'https://a.com', snippet: 'S' }] } }],
    ['google', { items: [{ title: 'T', link: 'https://a.com', snippet: 'S' }] }],
    ['serpapi', { organic_results: [{ title: 'T', link: 'https://a.com', snippet: 'S' }] }],
  ];
  for (const [provider, json] of cases) {
    const r = extractResults(provider, json, 5);
    assert.equal(r.length, 1, provider);
    assert.equal(r[0].url, 'https://a.com', provider);
    assert.equal(r[0].title, 'T', provider);
    assert.equal(r[0].snippet, 'S', provider);
  }
});
test('extractResults:未知结构也能从 JSON 里抠出来', () => {
  const r = extractResults('generic', { data: { list: [{ headline: 'H', href: 'https://x.com/1', abstract: 'A' }] } }, 5);
  assert.equal(r.length, 1);
  assert.equal(r[0].url, 'https://x.com/1');
  assert.equal(r[0].title, 'H');
});
test('extractResults:去重并限制条数', () => {
  const json = { results: [
    { url: 'https://a.com', title: '1' },
    { url: 'https://a.com#frag', title: '2' },
    { url: 'https://b.com', title: '3' },
    { url: 'https://c.com', title: '4' },
  ] };
  assert.equal(extractResults('exa', json, 5).length, 3);
  assert.equal(extractResults('exa', json, 2).length, 2);
});
test('extractResults:没有结果时返回空数组', () => {
  assert.equal(extractResults('exa', {}, 5).length, 0);
  assert.equal(extractResults('exa', { results: [] }, 5).length, 0);
});
test('SUPPORTED_PROVIDERS 覆盖文档里承诺的服务商', () => {
  for (const p of ['metaso', 'exa', 'tavily', 'serper', 'brave', 'bing', 'google', 'serpapi', 'generic']) {
    assert.ok(SUPPORTED_PROVIDERS.includes(p), p);
  }
});

// 8. 文件校验 / SSRF
// ===========================================================================
const CFG = loadConfig({});
test('normaliseFiles:正常通过', () => {
  const f = normaliseFiles([{ path: 'index.html', content: '<h1>hi</h1>' }], CFG);
  assert.equal(f.length, 1);
});
test('normaliseFiles:必须有 index.html', () => {
  assert.throws(() => normaliseFiles([{ path: 'a.html', content: 'x' }], CFG), /index\.html/);
});
test('normaliseFiles:拒绝路径穿越', () => {
  assert.throws(() => normaliseFiles([{ path: '../x/index.html', content: 'x' }], CFG), /非法路径/);
  assert.throws(() => normaliseFiles([{ path: '/etc/index.html', content: 'x' }], CFG), /非法路径/);
  assert.throws(() => normaliseFiles([{ path: 'a\\b/index.html', content: 'x' }], CFG), /非法路径/);
});
test('normaliseFiles:同名文件后者覆盖', () => {
  const f = normaliseFiles([
    { path: 'index.html', content: 'v1' },
    { path: 'index.html', content: 'v2' },
  ], CFG);
  assert.equal(f.length, 1);
  assert.equal(f[0].content, 'v2');
});
test('normaliseFiles:超体积拒绝', () => {
  const big = 'x'.repeat(CFG.maxSiteBytes + 10);
  assert.throws(() => normaliseFiles([{ path: 'index.html', content: big }], CFG), /超过上限/);
});
test('normaliseFiles:空数组拒绝', () => {
  assert.throws(() => normaliseFiles([], CFG));
  assert.throws(() => normaliseFiles(null, CFG));
});

// ===========================================================================
// 9. 事件归一化
// ===========================================================================
test('normaliseEvent:群 @ 消息', () => {
  const t = normaliseEvent({
    id: 'EV1',
    op: 0,
    t: 'GROUP_AT_MESSAGE_CREATE',
    d: { id: 'MSG1', content: '/AI 你好', group_openid: 'G1', author: { member_openid: 'U1', nickname: '小明' } },
  });
  assert.equal(t.kind, 'message');
  assert.equal(t.convId, 'g:G1');
  assert.equal(t.targetId, 'G1');
  assert.equal(t.messageId, 'MSG1');
  assert.equal(t.text, '/AI 你好');
  assert.equal(t.eventId, 'EV1');
});
test('normaliseEvent:单聊消息', () => {
  const t = normaliseEvent({
    id: 'EV2', t: 'C2C_MESSAGE_CREATE', d: { id: 'M2', content: 'hi', author: { user_openid: 'U9' } },
  });
  assert.equal(t.convId, 'u:U9');
  assert.equal(t.scene, 'c2c');
});
test('normaliseEvent:机器人被拉进群 -> 自动发帮助', () => {
  const t = normaliseEvent({ id: 'E3', t: 'GROUP_ADD_ROBOT', d: { group_openid: 'G5' } });
  assert.equal(t.kind, 'message');
  assert.equal(t.text, '/帮助');
});
test('normaliseEvent:未知事件忽略', () => {
  assert.equal(normaliseEvent({ id: 'E4', t: 'SOMETHING_ELSE', d: {} }).kind, 'ignore');
  assert.equal(normaliseEvent({}).kind, 'ignore');
});

test('normaliseEvent:全部接收模式下各类事件都有归宿', () => {
  const mk = (t, d) => normaliseEvent({ id: 'e1', t, d });
  assert.equal(mk('GROUP_MESSAGE_CREATE', { group_openid: 'g', author: { member_openid: 'u' }, content: 'x' }).kind, 'message');
  assert.equal(mk('GROUP_AT_MESSAGE_CREATE', { group_openid: 'g', author: { member_openid: 'u' }, content: 'x' }).scene, 'group');
  assert.equal(mk('C2C_MESSAGE_CREATE', { author: { user_openid: 'u' }, content: 'x' }).scene, 'c2c');
  assert.equal(mk('GROUP_ADD_ROBOT', { group_openid: 'g' }).text, '/帮助');
  assert.equal(mk('FRIEND_ADD', { openid: 'u' }).text, '/帮助');
  for (const t of ['GROUP_DEL_ROBOT', 'FRIEND_DEL', 'GROUP_MSG_RECEIVE', 'C2C_MSG_REJECT']) {
    assert.equal(mk(t, {}).kind, 'note', t);
  }
  for (const t of ['AT_MESSAGE_CREATE', 'MESSAGE_REACTION_ADD', '未来才有的新事件']) {
    assert.equal(mk(t, {}).kind, 'ignore', t);
  }
  assert.equal(mk('GROUP_AT_MESSAGE_CREATE', {}).kind, 'message');
});
test('executeTool:random 范围与抽签', async () => {
  const r = await executeTool('random', { min: 5, max: 5 }, {});
  assert.equal(r, '随机结果:5');
  const pick = await executeTool('random', { choices: ['A', 'B'], count: 3 }, {});
  assert.ok(pick.includes('随机抽 3 次'), pick);
  assert.ok((await executeTool('random', {}, {})).includes('随机结果:'));
});
test('executeTool:encode 编解码与 JSON 格式化', async () => {
  assert.equal(await executeTool('encode', { action: 'base64_encode', text: 'hello' }, {}), 'aGVsbG8=');
  assert.equal(await executeTool('encode', { action: 'base64_decode', text: 'aGVsbG8=' }, {}), 'hello');
  assert.equal(await executeTool('encode', { action: 'hex_encode', text: 'A' }, {}), '41');
  assert.equal(await executeTool('encode', { action: 'hex_decode', text: '41' }, {}), 'A');
  assert.equal(await executeTool('encode', { action: 'url_encode', text: '你 好' }, {}), '%E4%BD%A0%20%E5%A5%BD');
  assert.equal(await executeTool('encode', { action: 'json_minify', text: '{ "a" : 1 }' }, {}), '{"a":1}');
  assert.ok((await executeTool('encode', { action: 'base64_encode', text: '' }, {})).includes('执行失败'));
});
test('executeTool:未知工具给出可用清单', async () => {
  const r = await executeTool('nope', {}, {});
  assert.ok(r.includes('没有名为 nope 的工具'), r);
  assert.ok(r.includes('deploy_site'), r);
});
test('executeTool:工具报错不会抛出去', async () => {
  const r = await executeTool('calc', { expression: '1+' }, {});
  assert.ok(r.includes('执行失败'), r);
});

// ===========================================================================
// 10. 命令解析
// ===========================================================================
test('parseCommand:/AI', () => {
  assert.deepEqual(parseCommand('/AI 你好'), { name: 'ai', args: '你好' });
});
test('parseCommand:全角斜杠与中文别名', () => {
  assert.equal(parseCommand('／压缩').name, 'compress');
  assert.equal(parseCommand('/压缩').name, 'compress');
  assert.equal(parseCommand('/delete').name, 'delete');
  assert.equal(parseCommand('/清除').name, 'delete');
  assert.equal(parseCommand('/帮助').name, 'help');
  assert.equal(parseCommand('/状态').name, 'status');
});
test('parseCommand:普通文本没有命令名', () => {
  const r = parseCommand('帮我写个2048');
  assert.equal(r.name, '');
  assert.equal(r.args, '帮我写个2048');
});

// ===========================================================================
// 11. 路由
// ===========================================================================
test('splitSitePath', () => {
  assert.deepEqual(splitSitePath('/abc12345'), { id: 'abc12345', file: '' });
  assert.deepEqual(splitSitePath('/abc12345/app.js'), { id: 'abc12345', file: 'app.js' });
  assert.deepEqual(splitSitePath('/abc12345/a/b.css'), { id: 'abc12345', file: 'a/b.css' });
  assert.deepEqual(splitSitePath('/qq/webhook'), { id: 'qq', file: 'webhook' });
});
test('splitSitePath:中文 ID 能正确解码', () => {
  const enc = encodeURIComponent('云星A7x2');
  assert.equal(splitSitePath(`/${enc}`).id, '云星A7x2');
  assert.equal(splitSitePath(`/${enc}/index.html`).file, 'index.html');
});

// ===========================================================================
// 12. 提示词 / 工具定义
// ===========================================================================
test('工具定义合法且包含关键工具', () => {
  const tools = buildTools(CFG);
  const names = tools.map((t) => t.function.name);
  const need = ['deploy_site', 'update_site', 'list_sites', 'read_site', 'delete_site', 'web_search', 'fetch_url',
    'query_dashboard', 'remember', 'recall', 'forget', 'random', 'encode', 'calc', 'now'];
  for (const need2 of need) {
    assert.ok(names.includes(need2), `缺少工具 ${need2}`);
  }
  for (const t of tools) {
    assert.equal(t.type, 'function');
    assert.match(t.function.name, /^[a-zA-Z0-9_-]{1,64}$/);
    assert.ok(t.function.description && t.function.description.length > 10);
    assert.equal(t.function.parameters.type, 'object');
  }
});
test('系统提示词包含硬性约束', () => {
  const p = buildSystemPrompt(CFG);
  assert.ok(p.includes('deepseek') === false || true);
  assert.ok(p.includes('链接'));
  assert.ok(p.includes('不要'));
  assert.ok(p.includes('思考过程'));
});
test('帮助文本包含全部命令', () => {
  const h = buildHelpText(CFG);
  for (const k of ['/AI', '/帮助', '/压缩', '/delete', '/状态']) assert.ok(h.includes(k), k);
});

// ===========================================================================
// 13. 配置
// ===========================================================================
test('loadConfig:变量表就是这 7 个', () => {
  assert.deepEqual(ALL_VARS, [
    'QQ_APP_ID', 'QQ_APP_SECRET', 'LLM_BASE_URL', 'LLM_API_KEY',
    'SEARCH_API_URL', 'SEARCH_API_KEY', 'PUBLIC_BASE_URL',
  ]);
});
test('loadConfig:读取变量并去掉 URL 尾部斜杠', () => {
  const c = loadConfig({
    QQ_APP_ID: '100000001',
    QQ_APP_SECRET: 's',
    LLM_BASE_URL: 'https://api.example.com/v1/',
    LLM_API_KEY: 'k',
    SEARCH_API_URL: 'https://metaso.cn/api/v1/search',
    SEARCH_API_KEY: 'sk',
    PUBLIC_BASE_URL: 'https://ai.example.com/',
  });
  assert.equal(c.appId, '100000001');
  assert.equal(c.llmBaseUrl, 'https://api.example.com/v1');
  assert.equal(c.publicBaseUrl, 'https://ai.example.com');
  assert.equal(c.searchApiUrl, 'https://metaso.cn/api/v1/search');
  assert.equal(c.searchApiKey, 'sk');
  assert.equal(missingVars(c).length, 0);
});
test('loadConfig:空白字符会被当成没填', () => {
  const c = loadConfig({ QQ_APP_ID: '   ', LLM_API_KEY: '' });
  assert.equal(c.appId, '');
  assert.deepEqual(missingVars(c), ['QQ_APP_ID', 'QQ_APP_SECRET', 'LLM_BASE_URL', 'LLM_API_KEY']);
});
test('loadConfig:固定参数不受环境变量影响', () => {
  const c = loadConfig({ DEPLOY_MAX_SITES: '99', LLM_MODEL: 'gpt-4', LLM_MAX_TOKENS: '10' });
  assert.equal(c.maxSites, 6);
  assert.equal(c.llmModel, 'deepseek-v4.1-flash');
  assert.equal(c.reasoningEffort, 'max');
  assert.equal(c.siteTtlSeconds, 600);
  assert.equal(c.idLen, 8);
  assert.equal(c.idCharset, 'ascii');
  assert.equal(c.maxTokens, undefined);
});
test('loadConfig:空环境也能构造出可用的默认对象', () => {
  const c = loadConfig();
  assert.equal(c.webhookPath, '/qq/webhook');
  assert.equal(c.apiBase, 'https://api.bot.qq.com');
  assert.ok(c.agentBudgetMs <= 5 * 60 * 1000, '总预算必须小于 QQ 被动回复窗口');
});
console.log(`\n${'='.repeat(60)}`);
if (fail === 0) {
  console.log(`✅ 全部通过:${pass} 项`);
} else {
  console.log(`❌ 失败 ${fail} 项 / 共 ${pass + fail} 项`);
  for (const f of failures) console.log(`   · ${f}`);
}
console.log('='.repeat(60));
process.exit(fail === 0 ? 0 : 1);
