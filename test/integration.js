// 端到端集成测试(不需要 workerd)。
//
// 用 test/harness.js 在 Node 里模拟 Cloudflare 运行环境:
//   Worker 入口、Durable Object、SQLite 存储、闹钟调度 全部真跑,
//   只有「大模型网关」和「QQ 开放平台」被 test/mock-upstream.js 换成本地假服务。
//
// 跑法:node --experimental-sqlite test/integration.js

import fs from 'node:fs';
import path from 'node:path';
import { startMock } from './mock-upstream.js';
import { makeEnv, makeCtx, startAlarmRunner } from './harness.js';
import { keysFromSecret } from '../src/qq/sign.js';
import { executeTool } from '../src/agent/exec.js';
import { bytesToHex, concatBytes, utf8 } from '../src/util/bytes.js';

const MOCK = 'http://127.0.0.1:8790';
const BASE = 'http://bot.test';
const APP_SECRET = 'test-app-secret-not-real-0123456789';

let pass = 0, fail = 0;
const failures = [];
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    fail++;
    failures.push(`${name}: ${e?.message || e}`);
    console.log(`  ❌ ${name} — ${e?.message || e}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m || '断言失败'); }
function assertEq(a, b, m) { if (a !== b) throw new Error(`${m || '不相等'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs = 20000, label = '') {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时: ${label}`);
    await sleep(50);
  }
}

let worker;
let env;
let ctx;
let mock;
let alarmRunner;
let groupSeq = 0;

async function req(p, init) {
  return worker.fetch(new Request(BASE + p, init), env, ctx);
}

async function signBody(timestamp, bodyStr) {
  const { privateKey } = await keysFromSecret(APP_SECRET);
  const raw = new Uint8Array(await crypto.subtle.sign(
    { name: 'Ed25519' }, privateKey, concatBytes(utf8(timestamp), utf8(bodyStr)),
  ));
  return bytesToHex(raw);
}

function groupEvent(text) {
  groupSeq++;
  return {
    id: `EV_${Date.now()}_${groupSeq}`,
    op: 0,
    s: groupSeq,
    t: 'GROUP_AT_MESSAGE_CREATE',
    d: {
      id: `MSG_${groupSeq}`,
      content: text,
      timestamp: new Date().toISOString(),
      group_openid: 'GROUP_TEST_1',
      author: { member_openid: 'USER_TEST_1', nickname: '测试小明' },
    },
  };
}

async function postWebhook(payload, { signIt = true, tamper = null } = {}) {
  let body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  if (tamper) body = tamper(body);
  const ts = String(Math.floor(Date.now() / 1000));
  const headers = { 'Content-Type': 'application/json' };
  if (signIt) {
    headers['X-Signature-Ed25519'] = await signBody(ts, body);
    headers['X-Signature-Timestamp'] = ts;
  }
  const res = await req('/qq/webhook', { method: 'POST', headers, body });
  const text = await res.text();
  let j = null;
  try { j = JSON.parse(text); } catch { /* ignore */ }
  return { status: res.status, text, json: j };
}

/**
 * 发一条群消息并等机器人回完。
 * 命令类回复只有 1 条,Agent 回复是「正在思考」+ 正文共 2 条,
 * 所以统一等 1 条 + 静默窗口。
 */
async function say(text, timeout = 25000) {
  await sleep(400); // 排空上一条测试可能还在路上的消息
  const before = mock.calls.qqSend.length;
  const r = await postWebhook(groupEvent(text));
  assertEq(r.status, 200, '回调应返回 200');
  await waitFor(() => mock.calls.qqSend.length >= before + 1, timeout, `等待回复: ${text}`);
  await sleep(1200); // 等可能的第二条
  const sent = mock.calls.qqSend.slice(before);
  return { sent, text: sent.map((s) => s.body.content).join('\n') };
}

// ===========================================================================
async function main() {
  console.log('\n启动假上游(模型 + QQ 开放平台)…');
  mock = await startMock({ llmPort: 8790 });

  env = makeEnv({
    QQ_APP_ID: '100000001',
    QQ_APP_SECRET: APP_SECRET,
    LLM_BASE_URL: `${MOCK}/v1`,
    LLM_API_KEY: 'mock-key',
    SEARCH_API_URL: `${MOCK}/search`,
    SEARCH_API_KEY: 'mock-search-key',
    PUBLIC_BASE_URL: BASE,
    QQ_API_BASE: MOCK,
    QQ_TOKEN_URL: `${MOCK}/app/getAppAccessToken`,
  });
  ctx = makeCtx();
  alarmRunner = startAlarmRunner(env);

  const mod = await import('../src/index.js');
  worker = mod.default;

  console.log('\n=== 1. 基础路由 ===');
  await t('GET /health', async () => {
    const r = await req('/health');
    assertEq(r.status, 200);
    assertEq((await r.json()).ok, true);
  });

  await t('GET /check 全部必检项通过', async () => {
    const r = await req('/check');
    const d = await r.json();
    assertEq(r.status, 200, `自检失败项: ${JSON.stringify(d.checks?.filter((c) => !c.ok))}`);
    assertEq(d.ok, true);
  });

  await t('未知路径 404', async () => {
    assertEq((await req('/no/such/path')).status, 404);
  });

  await t('/check 列出了全部 7 个变量', async () => {
    const d = await (await req('/check')).json();
    assertEq(d.variables.length, 7);
    assert(d.variables.includes('SEARCH_API_URL'));
    assertEq(d.notes.length, 0, '变量齐全时不应有缺项提示');
  });

  await t('必填变量缺失时 /check 返回 500 并点名', async () => {
    const mod = await import('../src/index.js');
    const bare = { BOT_CORE: env.BOT_CORE };
    const res = await mod.default.fetch(new Request('http://bot.test/check'), bare, ctx);
    assertEq(res.status, 500);
    const d = await res.json();
    assert(d.notes.join(' ').includes('LLM_API_KEY'), '应点名缺 LLM_API_KEY');
  });

  console.log('\n=== 2. 回调安全 ===');
  await t('op=13 回调验证:signature 可被官方公钥验签', async () => {
    const r = await postWebhook({ op: 13, d: { plain_token: 'Arq0D5A61EgUu4OxUvOp', event_ts: '1725442341' } });
    assertEq(r.status, 200);
    assertEq(r.json.plain_token, 'Arq0D5A61EgUu4OxUvOp');
    assert(/^[0-9a-f]{128}$/.test(r.json.signature), '应为 128 位 hex');
    const { publicKey } = await keysFromSecret(APP_SECRET);
    const ok = await crypto.subtle.verify(
      { name: 'Ed25519' }, publicKey,
      Buffer.from(r.json.signature, 'hex'),
      utf8('1725442341Arq0D5A61EgUu4OxUvOp'),
    );
    assert(ok, '验签应通过');
  });

  await t('无签名头 -> 401', async () => {
    const r = await postWebhook(groupEvent('/帮助'), { signIt: false });
    assertEq(r.status, 401);
  });

  await t('body 被篡改 -> 401', async () => {
    const original = JSON.stringify(groupEvent('/帮助'));
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = await signBody(ts, original);          // 对原始 body 签名
    const tampered = original.replace('/帮助', '/删库跑路'); // 但发送篡改后的 body
    const res = await req('/qq/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Signature-Ed25519': sig,
        'X-Signature-Timestamp': ts,
      },
      body: tampered,
    });
    assertEq(res.status, 401);
  });

  await t('事件去重:同一条推送发两次只处理一次', async () => {
    const ev = groupEvent('/状态');
    const before = mock.calls.qqSend.length;
    await postWebhook(ev);
    await waitFor(() => mock.calls.qqSend.length > before, 15000, '第一次处理');
    await sleep(1200);
    const mid = mock.calls.qqSend.length;
    assert(mid > before, '第一次应该回了消息');
    await postWebhook(ev); // 同 event id 再发一次
    await sleep(1500);
    assertEq(mock.calls.qqSend.length, mid, '重复事件不应再回消息');
  });

  console.log('\n=== 3. 命令 ===');
  await t('@机器人发 /帮助 返回指令列表', async () => {
    const { text } = await say('/帮助');
    for (const k of ['/AI', '/压缩', '/delete', '/状态']) assert(text.includes(k), `帮助里缺少 ${k}`);
  });

  await t('@机器人但内容为空 -> 帮助', async () => {
    const { text } = await say('');
    assert(text.includes('/压缩') || text.includes('NB-AI'), '应返回帮助');
  });

  await t('/状态 返回运行信息', async () => {
    const { text } = await say('/状态');
    assert(text.includes('在线部署'), `状态内容不对: ${text.slice(0, 200)}`);
    assert(text.includes('deepseek-v4.1-flash'));
  });

  await t('联网搜索工具走配置的服务商', async () => {
    const core = env.BOT_CORE.core('core');
    const out = await executeTool('web_search', { query: '测试', count: 2 }, { cfg: core.cfg, core, convId: 'test' });
    assert(out.includes('example.com/one'), `应包含假搜索结果: ${out}`);
    assert(out.includes('搜索结果一'), out);
  });

  console.log('\n=== 4. Agent 全链路 + 部署 ===');
  let deployUrl = '';
  await t('「做个网页」-> 模型调 deploy_site -> 群里收到链接', async () => {
    const { sent, text } = await say('帮我做个测试网页');
    const m = new RegExp(`${BASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[^\\s\\]]+`).exec(text);
    assert(m, `回复里没有部署链接: ${text.slice(0, 300)}`);
    deployUrl = m[0];
    assert(sent.every((s) => s.path === '/v2/groups/GROUP_TEST_1/messages'), '消息应发到正确的群');
    assert(sent.every((s) => s.body.msg_id), '被动回复必须带 msg_id');
    assert(sent.every((s) => s.body.msg_type === 0), '应为文本消息');
    const seqs = sent.map((s) => s.body.msg_seq);
    assertEq(new Set(seqs).size, seqs.length, `msg_seq 必须每次不同: ${seqs}`);
  });

  await t('第一次思考回复不包含思考过程', async () => {
    const all = mock.calls.qqSend.map((s) => s.body.content).join('\n');
    assert(!all.includes('reasoning_content'), '不应把原始 reasoning 字段发出去');
    assert(!all.includes('用户要一个网页,我应该用 deploy_site'), '不应把思考内容发到群里');
  });

  await t('部署的网页可访问且内容正确', async () => {
    const r = await req(deployUrl.replace(BASE, ''));
    assertEq(r.status, 200);
    const html = await r.text();
    assert(html.includes('<h1>项目'), `页面内容不对: ${html.slice(0, 150)}`);
    assertEq(r.headers.get('content-type'), 'text/html; charset=utf-8');
    assert(r.headers.get('x-robots-tag').includes('noindex'));
    assert(r.headers.get('cache-control').includes('no-store'));
  });

  await t('子路径 /index.html 也能访问', async () => {
    const r = await req(`${deployUrl.replace(BASE, '')}/index.html`);
    assertEq(r.status, 200);
  });

  await t('内置后端 ./__data 读写正常', async () => {
    const p = `${deployUrl.replace(BASE, '')}/__data/score`;
    assertEq((await req(p)).status, 404, '未写入的键应 404');
    const w = await req(p, { method: 'POST', body: '{"hi":1}' });
    assertEq(w.status, 200, await w.text());
    assertEq(await (await req(p)).text(), '{"hi":1}');
  });

  await t('未知 ID 返回友好 404 页', async () => {
    const r = await req('/zzzz9999');
    assertEq(r.status, 404);
    assert((await r.text()).includes('项目不在了'));
  });

  await t('能列出部署详情(含剩余秒数)', async () => {
    const sites = env.BOT_CORE.core('core').listSites();
    assertEq(sites.length, 1, `实际有 ${sites.length} 个`);
    const left = Math.round((sites[0].expiresAt - Date.now()) / 1000);
    assert(left > 500 && left <= 600, `剩余时间应在 600 秒内: ${left}`);
    assertEq(sites[0].files.map((f) => f.path).join(','), 'index.html');
  });

  console.log('\n=== 5. 名额上限与淘汰 ===');
  await t('连续部署到 7 个:总数卡在 6', async () => {
    for (let i = 0; i < 6; i++) await say(`再做一个测试网页 ${i}`);
    const n = env.BOT_CORE.core('core').listSites().length;
    assertEq(n, 6, `站点数应被限制在 6,实际 ${n}`);
  });

  await t('淘汰的是「最久没改动」的那个,且会告知用户', async () => {
    const firstUrl = deployUrl;
    const { text } = await say('再做最后一个网页');
    assert(text.includes('自动清理') || text.includes('最久'), `应提示淘汰: ${text.slice(0, 300)}`);
    assertEq(env.BOT_CORE.core('core').listSites().length, 6);
    assertEq((await req(firstUrl.replace(BASE, ''))).status, 404, '最早的那个应已失效');
  });

  await t('update_site 会重置倒计时', async () => {
    // 直接操作 DO,验证「修改 -> expires_at 重置」
    const core = env.BOT_CORE.core('core');
    const list = core.listSites();
    const target = list[0];
    core.sql.exec('UPDATE sites SET updated_at = ?, expires_at = ? WHERE id = ?',
      Date.now() - 500000, Date.now() + 1000, target.id);
    const before = core.getSite(target.id);
    assert(before.expiresAt - Date.now() < 2000, '构造:快过期了');
    core.updateSite(target.id, { files: [{ path: 'index.html', content: '<h1>改过了</h1>' }] });
    const after = core.getSite(target.id);
    assert(after.expiresAt - Date.now() > 590000, '修改后应重新计时');
    assertEq(after.files.length, 1, '同名文件应被覆盖而不是新增');
  });

  await t('过期部署会被自动清理', async () => {
    const core = env.BOT_CORE.core('core');
    const list = core.listSites();
    const victim = list[0];
    core.sql.exec('UPDATE sites SET expires_at = ? WHERE id = ?', Date.now() - 1000, victim.id);
    core.purgeExpired();
    assertEq(core.getSite(victim.id), null, '过期站点应被删除');
  });

  await t('delete_site 能删掉部署', async () => {
    const core = env.BOT_CORE.core('core');
    const id = core.listSites()[0].id;
    assertEq(core.deleteSite(id), true);
    assertEq(core.getSite(id), null);
  });

  console.log('\n=== 6. 上下文管理 ===');
  await t('/delete 清空上下文', async () => {
    await say('/delete');
    const before = mock.calls.llmBodies.length;
    await say('你好呀');
    const body = mock.calls.llmBodies[before];
    const nonSystem = body.messages.filter((m) => m.role !== 'system');
    assertEq(nonSystem.length, 1, `清空后只应剩当前这一条: ${JSON.stringify(nonSystem.map((m) => m.role))}`);
  });

  await t('多轮对话会带上历史', async () => {
    await say('记住我叫小明');
    const before = mock.calls.llmBodies.length;
    await say('我叫什么');
    const body = mock.calls.llmBodies[before];
    const joined = body.messages.map((m) => m.content).join('\n');
    assert(joined.includes('记住我叫小明'), `历史没带上: ${joined.slice(0, 200)}`);
  });

  await t('/压缩 生成摘要并在后续请求里注入', async () => {
    const before = mock.calls.llmBodies.length;
    const { text } = await say('/压缩');
    assert(text.includes('压缩'), `应回复压缩结果: ${text.slice(0, 200)}`);
    const compressBody = mock.calls.llmBodies[before];
    assert(compressBody.messages.some((m) => String(m.content).includes('压缩')), '压缩请求应带压缩提示词');
    assert(!compressBody.tools, '压缩请求不应带工具');

    const before2 = mock.calls.llmBodies.length;
    await say('继续聊');
    const after = mock.calls.llmBodies[before2];
    const sysText = after.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    assert(sysText.includes('摘要'), `摘要没注入: ${sysText.slice(0, 300)}`);
  });

  await t('工具调用轮次带上了正确的 assistant/tool 消息', async () => {
    const withTools = mock.calls.llmBodies.filter((b) => b.tools && b.messages.some((m) => m.role === 'tool'));
    assert(withTools.length > 0, '应该有带工具结果的请求');
    const b = withTools[0];
    const asst = b.messages.find((m) => m.role === 'assistant' && m.tool_calls);
    assert(asst, '应有带 tool_calls 的 assistant 消息');
    const toolMsg = b.messages.find((m) => m.role === 'tool');
    assert(toolMsg.tool_call_id, 'tool 消息必须带 tool_call_id');
    assert(toolMsg.content.length > 0, 'tool 消息不能为空');
  });

  console.log('\n=== 7. 失败兜底 ===');
  await t('模型 504 时机器人给用户提示而不是静默', async () => {
    mock.breakOnce('chat');
    const before = mock.calls.qqSend.length;
    await postWebhook(groupEvent('这次一定会失败'));
    await waitFor(() => mock.calls.qqSend.length >= before + 1, 30000, '等待错误提示');
    await sleep(800);
    const msgs = mock.calls.qqSend.slice(before).map((s) => s.body.content).join('\n');
    assert(/出错|失败|🤔/.test(msgs), `应有提示: ${msgs.slice(0, 200)}`);
  });

  await t('模型返回空内容时也有兜底文案', async () => {
    mock.emptyOnce();
    const before = mock.calls.qqSend.length;
    await postWebhook(groupEvent('空回复测试'));
    await waitFor(() => mock.calls.qqSend.length >= before + 2, 30000, '等待兜底');
    const msgs = mock.calls.qqSend.slice(before).map((s) => s.body.content).join('\n');
    assert(msgs.length > 5, '不能什么都不发');
  });

  await t('出错后服务依然健康', async () => {
    assertEq((await req('/health')).status, 200);
  });

  console.log('\n=== 8. 输出到 QQ 的形态 ===');
  await t('长回复会被切成多条且每条不超长', async () => {
    mock.longOnce('x'.repeat(3000));
    const before = mock.calls.qqSend.length;
    await postWebhook(groupEvent('来一段超长回复'));
    await waitFor(() => mock.calls.qqSend.length >= before + 2, 30000, '等待长回复');
    await sleep(800);
    const sent = mock.calls.qqSend.slice(before);
    assert(sent.length <= 6, `最多 6 条(含提示),实际 ${sent.length}`);
    for (const s of sent) assert(s.body.content.length <= 900, `单条过长: ${s.body.content.length}`);
  });

  await t('QQ 报「不允许发送 URL」时自动降级重发', async () => {
    mock.rejectUrlOnce();
    const before = mock.calls.qqSend.length;
    const r = await postWebhook(groupEvent('帮我做个带链接的网页'));
    assertEq(r.status, 200);
    const stripped = (s) => /bot\.test|ai\.example/.test(s.body.content) && !s.body.content.includes('http://');
    await waitFor(
      () => mock.calls.qqSend.slice(before).some(stripped),
      30000,
      '等待降级重发(去掉协议头的那一条)',
    );
    const sent = mock.calls.qqSend.slice(before);
    assert(sent.some(stripped), '降级后应去掉协议头');
  });
}

main().then(async () => {
  console.log(`\n${'='.repeat(64)}`);
  if (fail === 0) console.log(`✅ 集成测试全部通过:${pass} 项`);
  else {
    console.log(`❌ 集成测试失败 ${fail} 项 / 共 ${pass + fail} 项`);
    for (const f of failures) console.log(`   · ${f}`);
  }
  console.log('='.repeat(64));
  try { alarmRunner?.stop(); } catch { /* ignore */ }
  try { await mock?.close(); } catch { /* ignore */ }
  process.exit(fail === 0 ? 0 : 1);
}).catch(async (e) => {
  console.error('集成测试自身崩了:', e);
  try { alarmRunner?.stop(); await mock?.close(); } catch { /* ignore */ }
  process.exit(1);
});
