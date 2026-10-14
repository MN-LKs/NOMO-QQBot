import http from 'node:http';
import worker from '../src/index.js';
import { makeEnv, makeCtx, startAlarmRunner } from './harness.js';
import { keysFromSecret } from '../src/qq/sign.js';
import { bytesToHex, concatBytes, utf8 } from '../src/util/bytes.js';

let pass = 0;
const fails = [];
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fails.push(`${name} — ${e?.message || e}`);
    console.log(`  ✗ ${name} — ${e?.message || e}`);
  }
}
function assert(c, m) {
  if (!c) throw new Error(m || '断言失败');
}

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// ---------------- 假上游:QQ 开放平台 + 大模型 ----------------
const calls = { token: 0, messages: [], llm: [] };
async function startUpstream() {
  const { server, port } = await listen((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const send = (o, s = 200) => {
        res.writeHead(s, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(o));
      };
      if (req.url.includes('getAppAccessToken')) {
        calls.token++;
        return send({ access_token: 'TOKEN_TEST', expires_in: 7200 });
      }
      if (/^\/v2\/(groups|users)\/.+\/messages/.test(req.url)) {
        calls.messages.push({ url: req.url, body: JSON.parse(body || '{}'), auth: req.headers.authorization });
        return send({ id: `SENT_${calls.messages.length}`, timestamp: Date.now() });
      }
      if (req.url.includes('/chat/completions')) {
        const reqBody = JSON.parse(body || '{}');
        calls.llm.push(reqBody);
        const msgs = reqBody.messages || [];
        const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
        const userText = typeof lastUser?.content === 'string' ? lastUser.content : '';
        const hasToolResult = msgs.some((m) => m.role === 'tool');
        const magic = [
          ['TEST_TOOL_REMEMBER', 'remember', { key: '测试键', value: '测试值' }],
          ['TEST_TOOL_DASHBOARD', 'query_dashboard', {}],
          ['TEST_TOOL_FETCH', 'fetch_url', { url: 'https://example.com/article' }],
          ['TEST_TOOL_LISTSITES', 'list_sites', {}],
        ].find(([mark]) => userText.includes(mark));
        if (magic && !hasToolResult) {
          const [, name, args] = magic;
          return send({
            id: 'chatcmpl-tool',
            object: 'chat.completion',
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [{ id: `call_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
              },
              finish_reason: 'tool_calls',
            }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          });
        }
        return send({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: magic ? `工具 ${magic[1]} 已完成,这是最终回复。` : '收到啦,我是测试机器人。' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        });
      }
      if (req.url.includes('/api/dashboard')) {
        return send({
          code: 0,
          data: {
            realtime: { all_requests: 12345, all_tokens: 6789012345, now: Math.floor(Date.now() / 1000) },
            windows: { today: { requests: 66, tokens: 1234567 } },
            totals: { quota: 2000000 },
            recent: [{ username: 'tester', model_name: 'test-model', tokens: 999, created_at: Math.floor(Date.now() / 1000) - 60 }],
          },
        });
      }
      if (req.url.includes('/extract')) {
        return send({ content: '这是网页查询 API 提取到的正文内容,专门给测试用。' });
      }
      if (req.url.includes('/models')) {
        return send({ data: [{ id: 'test-model-a' }, { id: 'test-model-b' }] });
      }
      if (req.url.includes('/websocket')) return send({ message: 'mock 不支持 WebSocket' }, 404);
      send({ message: 'not found' }, 404);
    });
  });
  return { server, port };
}

// ---------------- 假 MCP 服务器 ----------------
async function startMcp() {
  const tools = [
    { name: 'echo', description: '把输入原样返回', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
    { name: 'add', description: '两数相加', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } },
  ];
  const { server, port } = await listen((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const msg = JSON.parse(body || '{}');
      if (!msg.id) {
        res.writeHead(202);
        return res.end();
      }
      const reply = (result) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      };
      if (msg.method === 'initialize') return reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'mock', version: '1' } });
      if (msg.method === 'tools/list') return reply({ tools });
      if (msg.method === 'tools/call') {
        const a = msg.params?.arguments || {};
        const text = msg.params?.name === 'add' ? String(Number(a.a) + Number(a.b)) : String(a.text ?? '');
        return reply({ content: [{ type: 'text', text }] });
      }
      reply({});
    });
  });
  return { server, port };
}

// ---------------- 启动 ----------------
const up = await startUpstream();
const mcpSrv = await startMcp();
const env = makeEnv({
  ADMIN_USER: 'admin',
  ADMIN_PASS: 'pw-12345678',
  QQ_API_BASE: `http://127.0.0.1:${up.port}`,
});
const ctx = makeCtx();
const alarm = startAlarmRunner(env, { intervalMs: 15 });

let cookie = '';
async function call(path, { method = 'GET', body, headers = {}, useCookie = true } = {}) {
  const init = { method, headers: { 'CF-Connecting-IP': '10.0.0.1', ...headers } };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    init.headers['Content-Type'] = init.headers['Content-Type'] || 'application/json';
  }
  if (useCookie && cookie) init.headers.Cookie = cookie;
  const res = await worker.fetch(new Request(`https://panel.example.com${path}`, init), env, ctx);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, text, json, headers: res.headers };
}
async function api(path, opt) {
  return await call(`/administrator/api${path}`, opt);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

console.log('\n【面板与鉴权】');
await t('未登录访问接口返回 401', async () => {
  const r = await call('/administrator/api/overview', { useCookie: false });
  assert(r.status === 401, `实际 ${r.status}`);
});
await t('登录页可访问且不含敏感信息', async () => {
  const r = await call('/administrator', { useCookie: false });
  assert(r.status === 200, `实际 ${r.status}`);
  assert(r.text.includes('请登录'), '应显示登录表单');
  assert(!r.text.includes('pw-12345678'), '登录页不能泄露密码');
});
await t('错误密码被拒并计数', async () => {
  const r = await api('/login', { method: 'POST', body: { user: 'admin', pass: 'wrong-pass' }, useCookie: false });
  assert(r.status === 401, `实际 ${r.status}`);
  assert(/还剩/.test(r.json.error), r.json.error);
});
await t('正确密码登录成功并下发 Cookie', async () => {
  const r = await api('/login', { method: 'POST', body: { user: 'admin', pass: 'pw-12345678' }, useCookie: false });
  assert(r.status === 200 && r.json.ok, JSON.stringify(r.json));
  const setCookie = r.headers.get('Set-Cookie') || '';
  assert(setCookie.includes('HttpOnly'), 'Cookie 应带 HttpOnly');
  cookie = setCookie.split(';')[0];
});
await t('登录后可以访问面板页', async () => {
  const r = await call('/administrator');
  assert(r.status === 200 && r.text.includes('管理面板'), `实际 ${r.status}`);
});
await t('伪造 Cookie 无效', async () => {
  const bad = cookie.replace(/.$/, 'x');
  const res = await worker.fetch(new Request('https://panel.example.com/administrator/api/overview', {
    headers: { Cookie: bad },
  }), env, ctx);
  assert(res.status === 401, `实际 ${res.status}`);
});

console.log('\n【设置】');
await t('读取设置:默认连接方式为 WebSocket', async () => {
  const r = await api('/settings');
  assert(r.status === 200, `实际 ${r.status}`);
  assert(r.json.settings.qq.mode === 'websocket', r.json.settings.qq.mode);
  assert(r.json.callbackUrl.endsWith('/qq/webhook'), r.json.callbackUrl);
});
await t('保存 AI 接口与 QQ 凭据', async () => {
  const r = await api('/settings', {
    method: 'POST',
    body: {
      llm: { baseUrl: `http://127.0.0.1:${up.port}/v1`, apiKey: 'sk-test-1234567890', model: 'test-model-a' },
      qq: { mode: 'webhook', appId: '100000001', appSecret: 'test-app-secret-not-real' },
    },
  });
  assert(r.status === 200, JSON.stringify(r.json));
});
await t('密钥回读时被掩码', async () => {
  const r = await api('/settings');
  const k = r.json.settings.llm.apiKey;
  assert(k.includes('****'), k);
  assert(!k.includes('1234567890'), '掩码不应泄露完整 key');
});
await t('保存掩码值不会覆盖真实密钥', async () => {
  const cur = await api('/settings');
  await api('/settings', { method: 'POST', body: { llm: { apiKey: cur.json.settings.llm.apiKey } } });
  const r = await api('/settings');
  assert(r.json.settings.llm.apiKey.includes('sk-t'), r.json.settings.llm.apiKey);
});
await t('获取模型列表', async () => {
  const r = await api('/models', { method: 'POST', body: { baseUrl: `http://127.0.0.1:${up.port}/v1`, apiKey: 'sk-x' } });
  assert(r.status === 200 && r.json.models.length === 2, JSON.stringify(r.json));
});
await t('测试模型:对话与工具调用两项都跑', async () => {
  const r = await api('/test-llm', { method: 'POST', body: { baseUrl: `http://127.0.0.1:${up.port}/v1`, apiKey: 'sk-x', model: 'test-model-a' } });
  assert(r.status === 200, JSON.stringify(r.json));
  assert(r.json.chat && r.json.chat.ok, JSON.stringify(r.json.chat));
  assert(r.json.tool && typeof r.json.tool.ok === 'boolean', '应有工具调用结论');
});

console.log('\n【部署项目】');
let pid = '';
await t('面板部署一个项目', async () => {
  const r = await api('/projects', {
    method: 'POST',
    body: {
      name: '测试小游戏',
      description: '集成测试用',
      ttlMinutes: 10,
      files: [
        { path: 'index.html', content: '<!DOCTYPE html><html><body><h1>hello</h1><script src="app.js"></script></body></html>' },
        { path: 'app.js', content: 'console.log("hi");'.repeat(50) },
        { path: 'style.css', content: 'body{color:red}' },
      ],
    },
  });
  assert(r.status === 200 && r.json.id, JSON.stringify(r.json));
  pid = r.json.id;
  assert(/^[a-z0-9]{8}$/.test(pid), `ID 应为 8 位:${pid}`);
});
await t('访问部署好的页面', async () => {
  const r = await call(`/${pid}`);
  assert(r.status === 200, `实际 ${r.status}`);
  assert(r.text.includes('hello'), r.text.slice(0, 80));
  assert(r.headers.get('Content-Type').includes('text/html'), r.headers.get('Content-Type'));
});
await t('访问子文件与正确的 MIME', async () => {
  const css = await call(`/${pid}/style.css`);
  assert(css.status === 200 && css.text.includes('color:red'), css.text);
  assert(css.headers.get('Content-Type').includes('text/css'), css.headers.get('Content-Type'));
});
await t('不存在的文件返回 404 页面', async () => {
  const r = await call(`/${pid}/nope.js`);
  assert(r.status === 404, `实际 ${r.status}`);
});
await t('不存在的项目返回 404', async () => {
  const r = await call('/zzzz9999');
  assert(r.status === 404, `实际 ${r.status}`);
});
await t('项目数据接口可读可写', async () => {
  const w = await call(`/${pid}/__data/score`, { method: 'POST', body: '42' });
  assert(w.status === 200 && w.json.ok, JSON.stringify(w.json));
  const r = await call(`/${pid}/__data/score`);
  assert(r.json.value === '42', JSON.stringify(r.json));
});
await t('项目详情含文件与占用', async () => {
  const r = await api(`/projects/${pid}`);
  assert(r.status === 200, JSON.stringify(r.json));
  assert(r.json.files.length === 3, `文件数 ${r.json.files.length}`);
  assert(r.json.usage.bytes > 0, '应统计占用');
  assert(r.json.quota.limit >= r.json.quota.base, '额度应不小于保底');
});
await t('JS 文件被压缩存储', async () => {
  const r = await api(`/projects/${pid}`);
  const js = r.json.files.find((f) => f.path === 'app.js');
  assert(js.gz === true, '重复内容应被 gzip 压小');
  assert(js.size < js.rawSize, `${js.size} vs ${js.rawSize}`);
});
await t('查看文件内容(接口)', async () => {
  const r = await api(`/projects/${pid}/file?path=style.css`);
  assert(r.json.kind === 'text' && r.json.data.includes('color:red'), JSON.stringify(r.json).slice(0, 120));
});
await t('延续有效期', async () => {
  const before = (await api(`/projects/${pid}`)).json.project.expiresAt;
  await sleep(1100);
  const r = await api(`/projects/${pid}/extend`, { method: 'POST', body: { seconds: 600 } });
  assert(r.status === 200 && r.json.expiresAt > before, JSON.stringify(r.json));
});
await t('超出数量上限会被拒绝', async () => {
  for (let i = 0; i < 4; i++) {
    const r = await api('/projects', { method: 'POST', body: { name: `占位 ${i}`, ttlMinutes: 10, files: [{ path: 'index.html', content: `<h1>${i}</h1>` }] } });
    assert(r.status === 200, `第 ${i} 个部署失败:${JSON.stringify(r.json)}`);
  }
  const over = await api('/projects', { method: 'POST', body: { name: '第六个', ttlMinutes: 10, files: [{ path: 'index.html', content: 'x' }] } });
  assert(over.status === 400, `实际 ${over.status}`);
  assert(/上限/.test(over.json.error), over.json.error);
});
await t('删除项目会连 KV 数据一起清掉', async () => {
  const r = await api(`/projects/${pid}`, { method: 'DELETE' });
  assert(r.status === 200, JSON.stringify(r.json));
  const gone = await call(`/${pid}`);
  assert(gone.status === 404, `删除后仍可访问:${gone.status}`);
  const keys = [...env.STORE.map.keys()].filter((k) => k.startsWith(`f/${pid}/`));
  assert(keys.length === 0, `KV 还有残留:${keys.join(',')}`);
  const r2 = await api(`/projects/${pid}`);
  assert(r2.status === 404, '详情应 404');
});

await t('每日部署上限生效', async () => {
  await api('/settings', { method: 'POST', body: { deploy: { maxPerDay: 1 } } });
  const r = await api('/projects', { method: 'POST', body: { name: '再来一个', ttlMinutes: 10, files: [{ path: 'index.html', content: 'x' }] } });
  assert(r.status === 400, `实际 ${r.status}`);
  assert(/上限/.test(r.json.error), r.json.error);
  await api('/settings', { method: 'POST', body: { deploy: { maxPerDay: 50 } } });
});

console.log('\n【WebHook 与消息链路】');
await t('开启「允许所有群聊」', async () => {
  const r = await api('/settings', { method: 'POST', body: { groups: { allowAll: true } } });
  assert(r.status === 200, JSON.stringify(r.json));
  const cur = await api('/settings');
  assert(cur.json.settings.groups.allowAll === true, '开关没保存');
});
await t('WebSocket 模式下回调地址被禁用', async () => {
  await api('/settings', { method: 'POST', body: { qq: { mode: 'websocket' } } });
  const r = await call('/qq/webhook', { method: 'POST', body: '{}', useCookie: false });
  assert(r.status === 403, `实际 ${r.status}`);
});
await t('切回 WebHook 模式', async () => {
  const r = await api('/settings', { method: 'POST', body: { qq: { mode: 'webhook' } } });
  assert(r.status === 200, JSON.stringify(r.json));
});
await t('op=13 回调验证返回可验签的 signature', async () => {
  const payload = { op: 13, d: { plain_token: 'pt_test_123', event_ts: '1728000000' } };
  const r = await call('/qq/webhook', { method: 'POST', body: payload, useCookie: false });
  assert(r.status === 200, JSON.stringify(r.json));
  assert(r.json.plain_token === 'pt_test_123', '应回显 plain_token');
  assert(/^[0-9a-f]{128}$/.test(r.json.signature), `签名格式不对:${r.json.signature}`);
  const keys = await keysFromSecret('test-app-secret-not-real');
  const data = concatBytes(utf8('1728000000'), utf8('pt_test_123'));
  const okSig = await crypto.subtle.verify({ name: 'Ed25519' }, keys.publicKey, hexBytes(r.json.signature), data);
  assert(okSig, '签名验不过');
});
await t('未签名的消息事件被拒绝', async () => {
  const r = await call('/qq/webhook', { method: 'POST', body: { op: 0, t: 'GROUP_AT_MESSAGE_CREATE', d: {} }, useCookie: false });
  assert(r.status === 401, `实际 ${r.status}`);
});
await t('群消息走通全链路并回复到群里', async () => {
  const before = calls.messages.length;
  const ts = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({
    id: `EV_${Date.now()}`,
    op: 0,
    s: 1,
    t: 'GROUP_AT_MESSAGE_CREATE',
    d: { id: 'MSG_TEST_1', content: '你好', group_openid: 'GROUP_TEST_1', author: { member_openid: 'USER_TEST_1', nickname: '小明' } },
  });
  const keys = await keysFromSecret('test-app-secret-not-real');
  const sig = bytesToHex(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, keys.privateKey, concatBytes(utf8(ts), utf8(body)))));
  const r = await call('/qq/webhook', { method: 'POST', body, headers: { 'X-Signature-Ed25519': sig, 'X-Signature-Timestamp': ts }, useCookie: false });
  assert(r.status === 200, `实际 ${r.status} ${r.text.slice(0, 120)}`);

  for (let i = 0; i < 200 && calls.messages.length < before + 2; i++) await sleep(50);
  assert(calls.messages.length >= before + 2, `只发了 ${calls.messages.length - before} 条`);
  const receipt = calls.messages[before];
  const answer = calls.messages[before + 1];
  assert(receipt.body.content.includes('Agent 正在运行'), receipt.body.content);
  assert(receipt.body.msg_id === 'MSG_TEST_1', '回执应是被动回复');
  assert(answer.body.content.includes('测试机器人'), answer.body.content);
  assert(answer.body.msg_id === 'MSG_TEST_1', 'auto 模式:被动窗口内结果也应走被动回复');
  assert(answer.body.msg_seq > receipt.body.msg_seq, 'msg_seq 应递增');
  assert(answer.url.includes('GROUP_TEST_1'), answer.url);
  assert(calls.token >= 1, '应取过 access token');
});
await t('关闭开关后,名单内的群仍可用', async () => {
  await api('/settings', { method: 'POST', body: { groups: { allowAll: false } } });
  const cur = await api('/settings');
  const listed = cur.json.settings.groups.list.some((g) => g.openid === 'GROUP_TEST_1');
  assert(listed, '发过消息的群应被自动收录:' + JSON.stringify(cur.json.settings.groups.list));
  const before = calls.messages.length;
  const ts = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({
    id: `EV_${Date.now()}_listed`, op: 0, s: 9, t: 'GROUP_AT_MESSAGE_CREATE',
    d: { id: 'MSG_TEST_9', content: '还在吗', group_openid: 'GROUP_TEST_1', author: { member_openid: 'USER_TEST_1', nickname: '小明' } },
  });
  const keys = await keysFromSecret('test-app-secret-not-real');
  const sig = bytesToHex(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, keys.privateKey, concatBytes(utf8(ts), utf8(body)))));
  await call('/qq/webhook', { method: 'POST', body, headers: { 'X-Signature-Ed25519': sig, 'X-Signature-Timestamp': ts }, useCookie: false });
  for (let i = 0; i < 200 && calls.messages.length < before + 2; i++) await sleep(50);
  assert(calls.messages.length >= before + 2, `名单内的群应能收到回复,实际 ${calls.messages.length - before} 条`);
});
await t('群白名单:未授权群被忽略', async () => {
  const before = calls.messages.length;
  const ts = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({
    id: `EV_${Date.now()}_2`, op: 0, s: 2, t: 'GROUP_AT_MESSAGE_CREATE',
    d: { id: 'MSG_TEST_2', content: '你好', group_openid: 'GROUP_OTHER', author: { member_openid: 'USER_X', nickname: '路人' } },
  });
  const keys = await keysFromSecret('test-app-secret-not-real');
  const sig = bytesToHex(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, keys.privateKey, concatBytes(utf8(ts), utf8(body)))));
  await call('/qq/webhook', { method: 'POST', body, headers: { 'X-Signature-Ed25519': sig, 'X-Signature-Timestamp': ts }, useCookie: false });
  await sleep(600);
  assert(calls.messages.length === before, '白名单外的群不该收到回复');
});
await t('查信息指令返回 openID', async () => {
  const before = calls.messages.length;
  const ts = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({
    id: `EV_${Date.now()}_3`, op: 0, s: 3, t: 'GROUP_AT_MESSAGE_CREATE',
    d: { id: 'MSG_TEST_3', content: '/查信息', group_openid: 'GROUP_TEST_1', author: { member_openid: 'USER_TEST_1', nickname: '小明' } },
  });
  const keys = await keysFromSecret('test-app-secret-not-real');
  const sig = bytesToHex(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, keys.privateKey, concatBytes(utf8(ts), utf8(body)))));
  await call('/qq/webhook', { method: 'POST', body, headers: { 'X-Signature-Ed25519': sig, 'X-Signature-Timestamp': ts }, useCookie: false });
  for (let i = 0; i < 100 && calls.messages.length < before + 1; i++) await sleep(50);
  const msg = calls.messages[calls.messages.length - 1];
  assert(msg.body.content.includes('USER_TEST_1'), msg.body.content);
  assert(msg.body.content.includes('GROUP_TEST_1'), msg.body.content);
});

console.log('\n【全量消息与 /AI 触发】');
await t('全量群消息:非 /AI 开头完全不触发 AI', async () => {
  const llmBefore = calls.llm.length;
  const msgBefore = calls.messages.length;
  const ts = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({
    id: `EV_${Date.now()}_f1`, op: 0, s: 5, t: 'GROUP_MESSAGE_CREATE',
    d: { id: 'MSG_FULL_1', content: '大家中午吃什么', group_openid: 'GROUP_TEST_1', author: { member_openid: 'USER_TEST_1', nickname: '小明' } },
  });
  const keys = await keysFromSecret('test-app-secret-not-real');
  const sig = bytesToHex(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, keys.privateKey, concatBytes(utf8(ts), utf8(body)))));
  await call('/qq/webhook', { method: 'POST', body, headers: { 'X-Signature-Ed25519': sig, 'X-Signature-Timestamp': ts }, useCookie: false });
  await sleep(800);
  assert(calls.llm.length === llmBefore, '普通群聊消息不该调用模型');
  assert(calls.messages.length === msgBefore, '普通群聊消息不该收到任何回复');
});
await t('全量群消息:/AI 开头正常触发(回执+结果)', async () => {
  const msgBefore = calls.messages.length;
  const ts = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({
    id: `EV_${Date.now()}_f2`, op: 0, s: 6, t: 'GROUP_MESSAGE_CREATE',
    d: { id: 'MSG_FULL_2', content: '/AI 你好', group_openid: 'GROUP_TEST_1', author: { member_openid: 'USER_TEST_1', nickname: '小明' } },
  });
  const keys = await keysFromSecret('test-app-secret-not-real');
  const sig = bytesToHex(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, keys.privateKey, concatBytes(utf8(ts), utf8(body)))));
  await call('/qq/webhook', { method: 'POST', body, headers: { 'X-Signature-Ed25519': sig, 'X-Signature-Timestamp': ts }, useCookie: false });
  for (let i = 0; i < 200 && calls.messages.length < msgBefore + 2; i++) await sleep(50);
  assert(calls.messages.length >= msgBefore + 2, `应收到回执+结果,实际 ${calls.messages.length - msgBefore} 条`);
  const receipt = calls.messages[msgBefore];
  assert(receipt.body.msg_id === 'MSG_FULL_2', '回执应是被动回复');
});
await t('超窗消息跳过回执,结果用主动消息发回', async () => {
  const before = calls.messages.length;
  const stub = env.BOT_CORE.get(env.BOT_CORE.idFromName('core'));
  await stub.fetch('https://do/enqueue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      eventId: `EV_OLD_${Date.now()}`, kind: 'message', scene: 'group', mentioned: true,
      convId: 'g:GROUP_TEST_1', targetId: 'GROUP_TEST_1', messageId: 'MSG_OLD_1',
      userId: 'USER_TEST_1', nickname: '小明', text: '你好',
      ts: Date.now() - 10 * 60 * 1000,
    }),
  });
  for (let i = 0; i < 200 && calls.messages.length < before + 1; i++) await sleep(50);
  assert(calls.messages.length >= before + 1, '应发出结果');
  const answer = calls.messages[before];
  assert(!answer.body.msg_id, '超窗后应走主动消息');
  assert(answer.body.content.includes('测试机器人'), answer.body.content);
});

console.log('\n【Agent 工具】');
function resetDoCfg() {
  const core = env.BOT_CORE.core('core');
  if (core) { core._cfg = null; core._cfgAt = 0; }
}
async function sendGroupAt(content) {
  const id = `MSG_TOOL_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const ts = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({
    id, op: 0, s: 9, t: 'GROUP_AT_MESSAGE_CREATE',
    d: { id, content, group_openid: 'GROUP_TEST_1', author: { member_openid: 'USER_TEST_1', nickname: '小明' } },
  });
  const keys = await keysFromSecret('test-app-secret-not-real');
  const sig = bytesToHex(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, keys.privateKey, concatBytes(utf8(ts), utf8(body)))));
  await call('/qq/webhook', { method: 'POST', body, headers: { 'X-Signature-Ed25519': sig, 'X-Signature-Timestamp': ts }, useCookie: false });
}
async function toolResultFor(mark) {
  const llmBefore = calls.llm.length;
  const msgBefore = calls.messages.length;
  await sendGroupAt(mark);
  for (let i = 0; i < 300 && calls.messages.length < msgBefore + 2; i++) await sleep(50);
  assert(calls.messages.length >= msgBefore + 2, `应收到回执+结果(实际 ${calls.messages.length - msgBefore} 条)`);
  const toolMsgs = calls.llm.slice(llmBefore).flatMap((r) => (r.messages || []).filter((m) => m.role === 'tool'));
  assert(toolMsgs.length >= 1, '模型应收到工具结果');
  return toolMsgs.map((m) => String(m.content)).join('\n');
}

await t('工具 remember:回显带键值而不是 undefined', async () => {
  const text = await toolResultFor('TEST_TOOL_REMEMBER');
  assert(text.includes('记住了:测试键 → 测试值'), `实际:${text.slice(0, 200)}`);
  assert(!text.includes('undefined'), '不应出现 undefined');
});
await t('工具 query_dashboard:返回中转站用量', async () => {
  await api('/settings', { method: 'POST', body: { dashboard: { url: `http://127.0.0.1:${up.port}/api/dashboard` } } });
  resetDoCfg();
  const text = await toolResultFor('TEST_TOOL_DASHBOARD');
  assert(text.includes('累计请求'), `实际:${text.slice(0, 300)}`);
  assert(text.includes('1.2 万'), `应包含累计请求数,实际:${text.slice(0, 300)}`);
  assert(text.includes('tester'), `应包含最近调用,实际:${text.slice(0, 300)}`);
});
await t('工具 fetch_url:优先走网页查询 API', async () => {
  await api('/settings', { method: 'POST', body: { extract: { url: `http://127.0.0.1:${up.port}/extract`, format: 'json' } } });
  resetDoCfg();
  const text = await toolResultFor('TEST_TOOL_FETCH');
  assert(text.includes('经网页查询 API'), `实际:${text.slice(0, 300)}`);
  assert(text.includes('提取到的正文'), `实际:${text.slice(0, 300)}`);
});
await t('工具 list_sites:项目到期销毁后会解释原因', async () => {
  // 让现有项目全部立即过期,再部署一个"短命项目"也过期,等自动清理写日志
  await env.DB.prepare('UPDATE projects SET expires_at = ?').bind(Date.now() - 1000).run();
  const dep = await api('/projects', { method: 'POST', body: { name: '短命项目', ttlMinutes: 10, files: [{ path: 'index.html', content: 'x' }] } });
  assert(dep.status === 200 && dep.json.id, JSON.stringify(dep.json));
  await env.DB.prepare('UPDATE projects SET expires_at = ? WHERE id = ?').bind(Date.now() - 1000, dep.json.id).run();
  await sleep(400);
  const text = await toolResultFor('TEST_TOOL_LISTSITES');
  assert(text.includes('没有任何在线部署'), `实际:${text.slice(0, 300)}`);
  assert(text.includes('短命项目'), `应提到刚销毁的项目,实际:${text.slice(0, 300)}`);
});

console.log('\n【MCP】');
let mcpId = '';
await t('添加 MCP 服务器并自动连接', async () => {
  const r = await api('/mcp', { method: 'POST', body: { name: '测试服务器', url: `http://127.0.0.1:${mcpSrv.port}/mcp`, transport: 'http' } });
  assert(r.status === 200 && r.json.id, JSON.stringify(r.json));
  mcpId = r.json.id;
  const list = await api('/mcp');
  const s = list.json.servers.find((x) => x.id === mcpId);
  assert(s.tools.list.length === 2, `工具数 ${s.tools.list.length}`);
  assert(s.tools.enabled.length === 2, '默认全部启用');
});
await t('可以停用单个工具', async () => {
  await api(`/mcp/${mcpId}`, { method: 'POST', body: { tool: 'add', on: false } });
  const list = await api('/mcp');
  const s = list.json.servers.find((x) => x.id === mcpId);
  assert(!s.tools.enabled.includes('add'), JSON.stringify(s.tools.enabled));
  await api(`/mcp/${mcpId}`, { method: 'POST', body: { tool: 'add', on: true } });
});
await t('可以整体停用服务器', async () => {
  await api(`/mcp/${mcpId}`, { method: 'POST', body: { enabled: false } });
  const list = await api('/mcp');
  assert(!list.json.servers.find((x) => x.id === mcpId).enabled, '应已停用');
  await api(`/mcp/${mcpId}`, { method: 'POST', body: { enabled: true } });
});
await t('重新测试连接', async () => {
  const r = await api(`/mcp/${mcpId}/test`, { method: 'POST' });
  assert(r.status === 200 && r.json.count === 2, JSON.stringify(r.json));
});
await t('删除 MCP 服务器', async () => {
  const r = await api(`/mcp/${mcpId}`, { method: 'DELETE' });
  assert(r.status === 200, JSON.stringify(r.json));
  const list = await api('/mcp');
  assert(!list.json.servers.some((x) => x.id === mcpId), '应已删除');
});

console.log('\n【日志与统计】');
await t('日志里有记录', async () => {
  const r = await api('/logs?limit=50');
  assert(r.status === 200 && r.json.logs.length > 0, `日志 ${r.json.logs.length} 条`);
  assert(r.json.logs.some((l) => l.msg.includes('收到')), '应有消息记录');
});
await t('日志可以下载', async () => {
  const r = await call('/administrator/api/logs/download');
  assert(r.status === 200 && r.text.includes('['), r.text.slice(0, 60));
});
await t('日志可以清空', async () => {
  await api('/logs', { method: 'DELETE' });
  const r = await api('/logs');
  assert(r.json.logs.length === 0, `还有 ${r.json.logs.length} 条`);
});
await t('概览统计有数据', async () => {
  const r = await api('/overview');
  assert(r.status === 200, JSON.stringify(r.json));
  assert(r.json.totals.messages >= 3, `消息数 ${r.json.totals.messages}`);
  assert(r.json.totals.visits >= 1, `访问数 ${r.json.totals.visits}`);
  assert(r.json.totals.projects >= 1, `部署数 ${r.json.totals.projects}`);
  assert(r.json.groups.some((g) => g.openid === 'GROUP_TEST_1'), '群列表应有测试群');
});

console.log('\n【安全:旧接口已下线】');
for (const p of ['/health', '/healthz', '/check']) {
  await t(`${p} 不再暴露`, async () => {
    const r = await call(p, { useCookie: false });
    assert(r.status === 404, `实际 ${r.status}`);
  });
}
await t('绕过路径也拿不到健康信息', async () => {
  const r = await call('/administrator/api/../health', { useCookie: false });
  assert(!r.text.includes('"ok":true'), '不应返回健康检查 JSON');
});
await t('面板需要登录才能读项目列表', async () => {
  const r = await call('/administrator/api/projects', { useCookie: false });
  assert(r.status === 401, `实际 ${r.status}`);
});

console.log('\n【绑定缺失与扫描器路径】');
const bareEnv = makeEnv({ ADMIN_USER: 'admin', ADMIN_PASS: 'pw-12345678' });
delete bareEnv.DB;
delete bareEnv.STORE;

await t('未绑定 D1/KV 时,扫描器路径全部 404 而不是 500', async () => {
  for (const p of ['/', '/ab', '/env', '/env.dev', '/env.prod', '/env.local', '/.env', '/config.json', '/wp-login.php']) {
    const res = await worker.fetch(new Request(`https://panel.example.com${p}`), bareEnv, ctx);
    assert(res.status === 404, `${p} 实际 ${res.status}`);
  }
});
await t('未绑定 D1/KV 时,合法 ID 给出明确提示而不是 500', async () => {
  const res = await worker.fetch(new Request('https://panel.example.com/abcd1234'), bareEnv, ctx);
  assert(res.status === 503, `实际 ${res.status}`);
  const text = await res.text();
  assert(text.includes('DB') && text.includes('STORE'), `提示内容:${text.slice(0, 160)}`);
});
await t('绑定齐全后,扫描器路径仍然 404', async () => {
  for (const p of ['/env.dev', '/env.local']) {
    const res = await worker.fetch(new Request(`https://panel.example.com${p}`), env, ctx);
    assert(res.status === 404, `${p} 实际 ${res.status}`);
  }
});
await t('中文 ID + 压缩存储:编码 URL 直读还原', async () => {
  const { createProject } = await import('../src/store/projects.js');
  const big = '<h1>你好世界</h1>' + '这是一段足够长的重复内容用来触发压缩。'.repeat(10);
  const r = await createProject(env, { deploy: {} }, {
    id: '云星智创',
    name: '中文ID测试',
    files: [{ path: 'index.html', content: big }],
  });
  assert(!r.error, r.error);
  const raw = await env.STORE.get('f/云星智创/index.html', 'arrayBuffer');
  const bytes = new Uint8Array(raw);
  assert(bytes[0] === 0x1f && bytes[1] === 0x8b, '长文本应被 gzip 压缩存储');
  const res = await worker.fetch(new Request(`https://panel.example.com/${encodeURIComponent('云星智创')}`), env, ctx);
  assert(res.status === 200, `实际 ${res.status}`);
  const text = await res.text();
  assert(text === big, '直读解压后应与原文完全一致');
});
await t('保存站点域名后,面板与工具链接都用它', async () => {
  const r = await api('/settings', { method: 'POST', body: { site: { publicBaseUrl: 'https://ai.example.com' } } });
  assert(r.status === 200, JSON.stringify(r.json));
  const list = await api('/projects');
  assert(list.json.projects.length > 0, '应有项目');
  assert(
    list.json.projects.every((p) => p.url.startsWith('https://ai.example.com/')),
    JSON.stringify(list.json.projects.map((p) => p.url)),
  );
});
await t('保存限时开关与投递方式(可往返)', async () => {
  const r = await api('/settings', { method: 'POST', body: { llm: { timeLimitEnabled: true, maxSeconds: 45 }, qq: { answerDelivery: 'active' } } });
  assert(r.status === 200, JSON.stringify(r.json));
  const cur = await api('/settings');
  assert(cur.json.settings.llm.timeLimitEnabled === true, '限时开关没保存');
  assert(cur.json.settings.llm.maxSeconds === 45, '最大秒数没保存');
  assert(cur.json.settings.qq.answerDelivery === 'active', '投递方式没保存');
  await api('/settings', { method: 'POST', body: { llm: { timeLimitEnabled: false, maxSeconds: 600 }, qq: { answerDelivery: 'auto' } } });
});

alarm.stop();
up.server.close();
mcpSrv.server.close();
await ctx.drain().catch(() => null);

console.log(`\n${'='.repeat(60)}`);
if (fails.length) {
  console.log(`❌ 集成测试失败 ${fails.length} 项 / 共 ${pass + fails.length} 项`);
  for (const f of fails) console.log(`   · ${f}`);
  process.exit(1);
}
console.log(`✅ 集成测试全部通过:${pass} 项`);

function hexBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
