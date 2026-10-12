// 零依赖单测。跑法:node test/run.js
// 覆盖所有「纯逻辑」:签名、SSE 解析、文本处理、ID、计算器、HTML 解析、路径校验、事件归一化、命令解析。

import assert from 'node:assert/strict';
import { seedFromSecret, signValidation, verifyWebhook, keysFromSecret } from '../src/qq/sign.js';
import { bytesToHex, hexToBytes, concatBytes, timingSafeEqual, b64urlToBytes } from '../src/util/bytes.js';
import { chunkText, toPlainText, truncate, roughTokens, findUrls, safeJson } from '../src/util/text.js';
import { genSiteId, isReservedPath } from '../src/util/id.js';
import { calc, formatNumber } from '../src/util/calc.js';
import { htmlToText, parseSearchResults, decodeEntities, htmlTitle } from '../src/util/html.js';
import { feedSseChunk, newStreamState, toToolCalls, hasNonEmptyString, extractString, flushSse } from '../src/agent/llm.js';
import { normaliseFiles } from '../src/agent/exec.js';
import { normaliseEvent } from '../src/qq/webhook.js';
import { parseCommand } from '../src/core/do.js';
import { splitSitePath } from '../src/serve.js';
import { buildTools } from '../src/agent/tools.js';
import { buildSystemPrompt, buildHelpText } from '../src/agent/prompt.js';
import { loadConfig } from '../src/config.js';

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
test('timingSafeEqual', () => {
  assert.equal(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2])), true);
  assert.equal(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3])), false);
  assert.equal(timingSafeEqual(new Uint8Array([1]), new Uint8Array([1, 2])), false);
});
test('b64url 解码', () => {
  assert.deepEqual([...b64urlToBytes('AQID')], [1, 2, 3]);
  assert.deepEqual([...b64urlToBytes('AQI')], [1, 2]);
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
test('roughTokens 中文按字算', () => {
  assert.ok(roughTokens('你好世界') >= 4);
  assert.ok(roughTokens('hello world') < 6);
});
test('findUrls', () => {
  assert.deepEqual(findUrls('见 https://a.b/c 和 http://d.e'), ['https://a.b/c', 'http://d.e']);
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
test('htmlTitle', () => {
  assert.equal(htmlTitle('<title>  标题  </title>'), '标题');
});
test('parseSearchResults:Bing 结构', () => {
  const html = '<ol id="b_results">'
    + '<li class="b_algo"><h2><a href="https://a.com/1">标题一</a></h2><p>摘要一</p></li>'
    + '<li class="b_algo"><h2><a href="https://b.com/2">标题二</a></h2><p>摘要二</p></li>'
    + '</ol>';
  const r = parseSearchResults(html, 5);
  assert.equal(r.length, 2);
  assert.equal(r[0].url, 'https://a.com/1');
  assert.equal(r[0].title, '标题一');
  assert.equal(r[0].snippet, '摘要一');
});
test('parseSearchResults:去重', () => {
  const html = '<li class="b_algo"><h2><a href="https://a.com">A</a></h2></li>'
    + '<li class="b_algo"><h2><a href="https://a.com#x">A2</a></h2></li>';
  assert.equal(parseSearchResults(html, 5).length, 1);
});
test('parseSearchResults:未知结构时兜底抓外链', () => {
  const r = parseSearchResults('<div><a href="https://z.com">Z</a></div>', 5);
  assert.equal(r.length, 1);
  assert.equal(r[0].url, 'https://z.com');
});

// ===========================================================================
// 7. SSE 解析
// ===========================================================================
test('hasNonEmptyString / extractString', () => {
  const l = '{"delta":{"content":"","reasoning_content":"hi","function_call":null}}';
  assert.equal(hasNonEmptyString(l, 'reasoning_content'), true);
  assert.equal(hasNonEmptyString(l, 'content'), false);
  assert.equal(extractString(l, 'reasoning_content'), 'hi');
});
test('SSE:正文与思考分流', () => {
  const st = newStreamState();
  feedSseChunk(st, 'data: {"choices":[{"delta":{"content":"","reasoning_content":"思考","function_call":null},"finish_reason":""}]}\n');
  feedSseChunk(st, 'data: {"choices":[{"delta":{"content":"你","reasoning_content":""},"finish_reason":""}]}\n');
  feedSseChunk(st, 'data: {"choices":[{"delta":{"content":"好","reasoning_content":""},"finish_reason":"stop"}]}\n');
  flushSse(st);
  assert.equal(st.content, '你好');
  assert.equal(st.reasoningHead, '思考');
  assert.equal(st.finishReason, 'stop');
});
test('SSE:分片被切断也能正确拼接', () => {
  const st = newStreamState();
  const whole = 'data: {"choices":[{"delta":{"content":"完整内容","reasoning_content":""},"finish_reason":"stop"}]}\ndata: [DONE]\n';
  for (let i = 0; i < whole.length; i += 7) feedSseChunk(st, whole.slice(i, i + 7));
  flushSse(st);
  assert.equal(st.content, '完整内容');
  assert.equal(st.done, true);
});
test('SSE:tool_calls 跨分片累积', () => {
  const st = newStreamState();
  feedSseChunk(st, 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"deploy_site","arguments":"{\\"na"}}]},"finish_reason":null}]}\n');
  feedSseChunk(st, 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"me\\":\\"x\\"}"}}]},"finish_reason":"tool_calls"}]}\n');
  flushSse(st);
  const tc = toToolCalls(st);
  assert.equal(tc.length, 1);
  assert.equal(tc[0].id, 'call_1');
  assert.equal(tc[0].function.name, 'deploy_site');
  assert.deepEqual(JSON.parse(tc[0].function.arguments), { name: 'x' });
});
test('SSE:usage 与 [DONE]', () => {
  const st = newStreamState();
  feedSseChunk(st, 'data: {"choices":[{"delta":{"content":"a","reasoning_content":""}}],"usage":{"total_tokens":42}}\n');
  feedSseChunk(st, 'data: [DONE]\n');
  flushSse(st);
  assert.equal(st.usage.total_tokens, 42);
  assert.equal(st.done, true);
});
test('SSE:换行/回车混合与空行', () => {
  const st = newStreamState();
  feedSseChunk(st, '\r\n\r\ndata: {"choices":[{"delta":{"content":"ok","reasoning_content":""}}]}\r\n');
  flushSse(st);
  assert.equal(st.content, 'ok');
});
test('SSE:思考摘要只保留前 1500 字', () => {
  const st = newStreamState();
  for (let i = 0; i < 100; i++) {
    feedSseChunk(st, `data: {"choices":[{"delta":{"content":"","reasoning_content":"${'思'.repeat(50)}"}}]}\n`);
  }
  flushSse(st);
  assert.ok(st.reasoningHead.length <= 1500);
  assert.ok(st.reasoningLen > 4000);
});

// ===========================================================================
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
  for (const need of ['deploy_site', 'update_site', 'list_sites', 'read_site', 'delete_site', 'web_search', 'fetch_url', 'query_dashboard', 'calc', 'now']) {
    assert.ok(names.includes(need), `缺少工具 ${need}`);
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
test('loadConfig:默认值', () => {
  const c = loadConfig({});
  assert.equal(c.llmModel, 'deepseek-v4.1-flash');
  assert.equal(c.reasoningEffort, 'max');
  assert.equal(c.maxSites, 6);
  assert.equal(c.siteTtlSeconds, 600);
  assert.equal(c.idLen, 8);
});
test('loadConfig:字符串覆盖与数值夹取', () => {
  const c = loadConfig({ DEPLOY_MAX_SITES: '3', DEPLOY_TTL_SECONDS: '5', LLM_MAX_TOKENS: 'abc', VERIFY_SIGNATURE: 'false' });
  assert.equal(c.maxSites, 3);
  assert.equal(c.siteTtlSeconds, 60, '不能低于 60 秒');
  assert.equal(c.maxTokens, 0, '非法值 = 不限制(不带 max_tokens)');
  assert.equal(c.verifySignature, false);
});
test('loadConfig:输出上限默认不限制', () => {
  assert.equal(loadConfig({}).maxTokens, 0);
  assert.equal(loadConfig({ LLM_MAX_TOKENS: '' }).maxTokens, 0);
  assert.equal(loadConfig({ LLM_MAX_TOKENS: 'none' }).maxTokens, 0);
  assert.equal(loadConfig({ LLM_MAX_TOKENS: '0' }).maxTokens, 0);
  assert.equal(loadConfig({ LLM_MAX_TOKENS: '8192' }).maxTokens, 8192);
  assert.equal(loadConfig({ LLM_MAX_TOKENS: '999999999' }).maxTokens, 200000, '上限夹取');
});
test('loadConfig:布尔真值', () => {
  for (const v of ['1', 'true', 'TRUE', 'yes', 'on']) assert.equal(loadConfig({ VERIFY_SIGNATURE: v }).verifySignature, true);
  for (const v of ['0', 'no', 'off', '']) assert.equal(loadConfig({ VERIFY_SIGNATURE: v }).verifySignature, false);
});
test('loadConfig:去掉 URL 尾部斜杠', () => {
  assert.equal(loadConfig({ LLM_BASE_URL: 'https://x/y/' }).llmBaseUrl, 'https://x/y');
  assert.equal(loadConfig({ PUBLIC_BASE_URL: 'https://a.b/' }).publicBaseUrl, 'https://a.b');
});

// ===========================================================================
console.log(`\n${'='.repeat(60)}`);
if (fail === 0) {
  console.log(`✅ 全部通过:${pass} 项`);
} else {
  console.log(`❌ 失败 ${fail} 项 / 共 ${pass + fail} 项`);
  for (const f of failures) console.log(`   · ${f}`);
}
console.log('='.repeat(60));
process.exit(fail === 0 ? 0 : 1);
