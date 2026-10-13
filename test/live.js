// 活体测试:打真实上游,验证请求形状与真实网关兼容。会消耗额度,默认不跑。
//
// 跑法:
//   LLM_BASE_URL=https://api.example.com/v1 LLM_API_KEY=sk-xxx node test/live.js
// 可选:LLM_MODEL、SEARCH_API_URL、SEARCH_API_KEY

import { loadConfig } from '../src/config.js';
import { chatWithFallback, chatOnce } from '../src/agent/llm.js';
import { executeTool } from '../src/agent/exec.js';
import { buildTools } from '../src/agent/tools.js';

const base = process.env.LLM_BASE_URL || '';
const key = process.env.LLM_API_KEY || '';

if (!base || !key) {
  console.log('\n跳过活体测试:需要同时设置 LLM_BASE_URL 和 LLM_API_KEY。');
  console.log('跑法:LLM_BASE_URL=https://api.example.com/v1 LLM_API_KEY=sk-xxx node test/live.js\n');
  process.exit(0);
}

const cfg = loadConfig({
  LLM_BASE_URL: base,
  LLM_API_KEY: key,
  SEARCH_API_URL: process.env.SEARCH_API_URL || '',
  SEARCH_API_KEY: process.env.SEARCH_API_KEY || '',
});

let pass = 0;
let fail = 0;
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

await t('非流式请求能拿到正文与思考', async () => {
  const r = await chatOnce(cfg, [{ role: 'user', content: '用一句话解释什么是递归。' }], null);
  console.log(`    思考 ${r.reasoningLen} 字 / 正文 ${r.content.length} 字 / finish=${r.finishReason} / ${r.elapsedMs}ms`);
  if (!r.content.trim()) throw new Error('正文为空');
  if (r.reasoningHead) console.log(`    思考摘录: ${r.reasoningHead.replace(/\s+/g, ' ').slice(0, 120)}`);
});

await t('工具调用能被正确解析', async () => {
  const tools = buildTools(cfg);
  const r = await chatOnce(cfg, [
    { role: 'system', content: '需要算术时必须调用 calc 工具。' },
    { role: 'user', content: '17 乘以 23 等于多少?' },
  ], tools);
  if (!r.toolCalls.length) throw new Error(`没有产生工具调用,finish=${r.finishReason} content=${r.content.slice(0, 100)}`);
  const tc = r.toolCalls[0];
  console.log(`    调用 ${tc.function.name}(${tc.function.arguments})`);
  const out = await executeTool(tc.function.name, JSON.parse(tc.function.arguments), { cfg, core: null, convId: 'test' });
  console.log(`    工具返回: ${out}`);
  if (!out.includes('391')) throw new Error(`计算结果不对: ${out}`);
});

await t('难题:max 档没产出正文时会自动降级重试', async () => {
  const r = await chatWithFallback(cfg, [
    { role: 'user', content: '简述 3x3 魔方 God Number 的推导思路。' },
  ], null);
  console.log(`    尝试 ${r.attempts} 次${r.downgradedFrom ? `(从 ${r.downgradedFrom} 降到 ${r.downgradedTo})` : ''} / 正文 ${r.content.length} 字 / ${r.elapsedMs}ms`);
  if (!r.content.trim()) throw new Error('降级后依然没有正文');
});

await t('联网搜索(未配置则跳过)', async () => {
  if (!cfg.searchApiUrl) {
    console.log('    未配置 SEARCH_API_URL,跳过');
    return;
  }
  const out = await executeTool('web_search', { query: 'Cloudflare Workers 免费额度', count: 3 }, { cfg });
  console.log(`    ${out.replace(/\n/g, '\n    ').slice(0, 400)}`);
  if (out.includes('没有拿到结果')) throw new Error(out.slice(0, 300));
});

await t('抓网页能用', async () => {
  const out = await executeTool('fetch_url', { url: 'https://developers.cloudflare.com/workers/platform/limits/', max_chars: 600 }, { cfg });
  console.log(`    ${out.replace(/\s+/g, ' ').slice(0, 200)}`);
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
