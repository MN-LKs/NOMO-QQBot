// 活体测试:拿真实上游跑一遍,验证「我们的请求形状」和「真实网关」是兼容的。
// 会消耗少量额度,所以默认不跑,而且密钥只从环境变量读 —— 仓库里不留任何真实凭据。
//
// 跑法:
//   LLM_API_KEY=sk-xxxx node test/live.js
// 可选:LLM_BASE_URL / DASHBOARD_URL 覆盖默认值。
//
// 只测三件事:
//   1. 流式 + reasoning_effort=max + stream_options 能不能正常拿到正文
//   2. 工具调用能不能被我们的解析器正确还原
//   3. 中转站用量接口能不能读

import { loadConfig } from '../src/config.js';
import { chatWithFallback, chatStream } from '../src/agent/llm.js';
import { executeTool } from '../src/agent/exec.js';
import { buildTools } from '../src/agent/tools.js';

if (!process.env.LLM_API_KEY) {
  console.log('\n跳过活体测试:没有设置 LLM_API_KEY 环境变量。');
  console.log('跑法:LLM_API_KEY=sk-xxxx node test/live.js\n');
  process.exit(0);
}

const cfg = loadConfig({
  LLM_BASE_URL: process.env.LLM_BASE_URL || 'https://api.example.com/v1',
  LLM_API_KEY: process.env.LLM_API_KEY,
  LLM_MODEL: process.env.LLM_MODEL || 'deepseek-v4.1-flash',
  LLM_REASONING_EFFORT: 'max',
  LLM_FALLBACK_EFFORT: 'low',
  DASHBOARD_URL: process.env.DASHBOARD_URL || 'https://manage.example.com/api/dashboard',
});

let pass = 0, fail = 0;
const failures = [];
async function t(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    pass++;
    console.log(`  ✅ ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (e) {
    fail++;
    failures.push(`${name}: ${e?.message || e}`);
    console.log(`  ❌ ${name} — ${e?.message || e}`);
  }
}

console.log(`\n活体测试 -> ${cfg.llmBaseUrl} / ${cfg.llmModel}\n`);

await t('简单问答:max 档思考能拿到正文', async () => {
  const r = await chatWithFallback(cfg, [{ role: 'user', content: '用一句话解释什么是递归。' }], null);
  console.log(`    思考 ${r.reasoningLen} 字 / 正文 ${r.content.length} 字 / finish=${r.finishReason} / ${r.elapsedMs}ms`);
  if (!r.content.trim()) throw new Error('正文为空');
  if (r.reasoningHead) console.log(`    思考摘录: ${r.reasoningHead.replace(/\s+/g, ' ').slice(0, 120)}`);
});

await t('工具调用:模型会调 calc,参数能被解析', async () => {
  const tools = buildTools(cfg);
  const r = await chatStream(cfg, [
    { role: 'system', content: '需要算术时必须调用 calc 工具。' },
    { role: 'user', content: '17 乘以 23 等于多少?' },
  ], tools, { maxTokens: 2048 });
  if (!r.toolCalls.length) throw new Error(`没有产生工具调用,finish=${r.finishReason} content=${r.content.slice(0, 100)}`);
  const tc = r.toolCalls[0];
  console.log(`    调用 ${tc.function.name}(${tc.function.arguments})`);
  const args = JSON.parse(tc.function.arguments);
  const out = await executeTool(tc.function.name, args, { cfg, core: null, convId: 'test' });
  console.log(`    工具返回: ${out}`);
  if (!out.includes('391')) throw new Error(`计算结果不对: ${out}`);
});

await t('难题:max 档思考烧光预算时会自动降级拿到正文', async () => {
  const r = await chatWithFallback(cfg, [
    { role: 'user', content: '简述 3x3 魔方 God Number 的推导思路。' },
  ], null);  // 用生产配置(不限制输出长度)
  console.log(`    尝试 ${r.attempts} 次${r.downgradedFrom ? `(从 ${r.downgradedFrom} 降到 ${r.downgradedTo})` : ''} / 正文 ${r.content.length} 字 / ${r.elapsedMs}ms`);
  if (!r.content.trim()) throw new Error('降级后依然没有正文');
  console.log(`    正文开头: ${r.content.replace(/\s+/g, ' ').slice(0, 100)}`);
});

await t('中转站用量接口可读', async () => {
  const out = await executeTool('query_dashboard', {}, { cfg });
  console.log(`    ${out.split('\n').slice(0, 4).join('\n    ')}`);
  if (out.includes('失败')) throw new Error(out);
});

await t('联网搜索能用', async () => {
  const out = await executeTool('web_search', { query: 'Cloudflare Workers 免费额度', count: 3 }, { cfg });
  console.log(`    ${out.replace(/\n/g, '\n    ').slice(0, 400)}`);
  if (out.includes('搜索失败')) throw new Error(out.slice(0, 300));
});

await t('抓网页能用', async () => {
  const out = await executeTool('fetch_url', { url: 'https://developers.cloudflare.com/workers/platform/limits/', max_chars: 600 }, { cfg });
  console.log(`    ${out.replace(/\n/g, ' ').slice(0, 200)}`);
  if (out.includes('执行失败')) throw new Error(out.slice(0, 200));
});

console.log(`\n${'='.repeat(60)}`);
if (fail === 0) console.log(`✅ 活体测试全部通过:${pass} 项`);
else {
  console.log(`❌ 活体测试失败 ${fail} 项 / 共 ${pass + fail} 项`);
  for (const f of failures) console.log(`   · ${f}`);
}
console.log('='.repeat(60));
process.exit(fail === 0 ? 0 : 1);
