import { chatWithFallback } from './llm.js';
import { buildTools } from './tools.js';
import { executeTool } from './exec.js';
import { buildSystemPrompt } from './prompt.js';
import { truncate } from '../util/text.js';

const TOTAL_BUDGET_MS = 4 * 60 * 1000;

export async function runAgent({ cfg, core, convId, userText, meta = {}, log = console.log }) {
  const started = Date.now();
  const tools = buildTools(cfg);
  const ctx = { cfg, core, convId };

  const conv = await core.getContext(convId);
  const messages = [{ role: 'system', content: buildSystemPrompt(cfg, meta) }];

  if (conv.summary) {
    messages.push({ role: 'system', content: `以下是这个群之前聊天的摘要,作为背景参考:\n${conv.summary}` });
  }
  const memories = core.memList ? core.memList(convId) : [];
  if (memories.length) {
    messages.push({
      role: 'system',
      content: '这个会话长期记住的信息(用户让你记的,直接当事实用):\n'
        + memories.map((m) => `· ${m.key}: ${m.value}`).join('\n'),
    });
  }

  for (const m of conv.messages) {
    messages.push({ role: m.role, content: m.content });
  }

  let speaker = userText;
  if (meta.nickname) speaker = `[${meta.nickname}] ${userText}`;
  messages.push({ role: 'user', content: speaker });

  const toolTrace = [];
  let final = '';
  let rounds = 0;
  let usageTotal = 0;
  let downgraded = false;
  let lastError = '';

  for (let round = 0; round < cfg.agentMaxRounds; round++) {
    if (Date.now() - started > TOTAL_BUDGET_MS) {
      log('[agent] 超出总时间预算,提前收尾');
      break;
    }
    rounds++;

    const left = TOTAL_BUDGET_MS - (Date.now() - started);
    const resp = await chatWithFallback(cfg, messages, tools, {
      timeoutMs: Math.max(20000, Math.min(cfg.llmTimeoutMs, left + 5000)),
    });

    if (resp.downgradedFrom) downgraded = true;
    if (resp.error) lastError = resp.error;
    if (resp.usage?.total_tokens) usageTotal += resp.usage.total_tokens;

    log(`[思考] round=${round + 1} effort=${resp.downgradedFrom ? cfg.fallbackEffort : cfg.reasoningEffort} `
      + `finish=${resp.finishReason} 思考片数=${resp.reasoningLen} 正文=${resp.content.length}字 `
      + `耗时=${resp.elapsedMs}ms${resp.aborted ? ' [被超时中断]' : ''}`);
    if (resp.reasoningHead) {
      log(`[思考·摘录] ${resp.reasoningHead.replace(/\s+/g, ' ').slice(0, 800)}`);
    }

    const calls = resp.toolCalls.slice(0, cfg.agentMaxToolsPerRound);
    if (calls.length === 0) {
      final = resp.content;
      break;
    }

    messages.push({
      role: 'assistant',
      content: resp.content || '',
      tool_calls: calls,
    });

    for (const call of calls) {
      const name = call.function?.name || '';
      let args = {};
      try {
        args = JSON.parse(call.function?.arguments || '{}');
      } catch {
        args = {};
      }
      const t0 = Date.now();
      const result = await executeTool(name, args, ctx);
      const ms = Date.now() - t0;
      toolTrace.push({ name, args, result: truncate(result, 500), ms });
      log(`[工具] ${name} ${JSON.stringify(args).slice(0, 200)} -> ${ms}ms :: ${String(result).replace(/\s+/g, ' ').slice(0, 300)}`);
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: String(result),
      });
    }

    if (round === cfg.agentMaxRounds - 1) {
      messages.push({
        role: 'user',
        content: '现在请直接用简体中文给出最终回复,不要再调用任何工具。',
      });
      const last = await chatWithFallback(cfg, messages, null, { timeoutMs: 60000 });
      if (last.content.trim()) final = last.content;
    }
  }

  if (!final.trim()) {
    if (toolTrace.length) {
      final = '事情办完了,但模型没给出说明。工具执行结果:\n'
        + toolTrace.map((t) => `· ${t.name} → ${t.result.slice(0, 120)}`).join('\n');
    } else if (lastError) {
      final = `😵 这次没能拿到模型的回复,上游接口报错了(${truncate(lastError, 120)})。稍后再试一次吧。`;
    } else {
      final = '抱歉,这次没生成出内容,换个说法再问我一次?';
    }
  }

  return {
    reply: final,
    toolTrace,
    rounds,
    usageTotal,
    downgraded,
    elapsedMs: Date.now() - started,
    historyUser: userText,
    historyAssistant: final,
  };
}
