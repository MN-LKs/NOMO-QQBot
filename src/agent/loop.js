import { chatWithFallback } from './llm.js';
import { buildTools } from './tools.js';
import { executeTool } from './exec.js';
import { buildSystemPrompt } from './prompt.js';
import { truncate, clipMiddle } from '../util/text.js';
import { mcpToolDefs, callMcp } from './mcp.js';
import { listSkills, pickSkills } from './skills.js';
import { loadExts, enabledToolSet, externalToolDefs, runExternalTool } from './exts.js';
import { listModules, agentModules, siteModules } from '../store/modules.js';

export async function runAgent({ cfg, core, convId, userText, meta = {}, log = console.log }) {
  const started = Date.now();
  // 总预算:0 表示不限制(大工程多轮工具调用需要多久就多久,只受轮次上限约束)
  const totalBudgetMs = Math.max(0, Number(cfg.agentBudgetMs) || 0);
  // 单次非流式请求的超时:默认不限制;管理员打开"单次请求限时"开关后才生效
  const perCallTimeoutMs = cfg.llmTimeLimitEnabled ? Math.max(5, Number(cfg.llmMaxSeconds) || 600) * 1000 : 0;

  let mcp = { defs: [], map: new Map() };
  try {
    mcp = await mcpToolDefs(core.env);
  } catch {
    mcp = { defs: [], map: new Map() };
  }

  // 扩展(内置开关/外部扩展)、技能、预制后端模块:任何一步失败都不挡主流程,
  // 退化成「内置工具全开、无技能、无模块」。
  let skills = [];
  let toolSet = null;
  let extTools = { defs: [], map: new Map() };
  let modules = [];
  let prefabList = [];
  try {
    const [skillRows, extState, moduleRows] = await Promise.all([
      listSkills(core.env, { enabledOnly: true }),
      loadExts(core.env),
      listModules(core.env, { enabledOnly: true }),
    ]);
    skills = pickSkills(skillRows, userText, cfg.skillMaxInject || 6000);
    toolSet = enabledToolSet(extState);
    extTools = externalToolDefs(extState);
    modules = agentModules(moduleRows);
    prefabList = siteModules(moduleRows).map((m) => ({ id: m.id, name: m.name, description: m.description }));
  } catch {
    /* 加载失败:用默认值 */
  }

  const tools = [...buildTools(cfg, { toolSet, modules, prefabList, externalDefs: extTools.defs }), ...mcp.defs];
  const ctx = { cfg, core, convId, modules: new Map(modules.map((m) => [m.id, m])), log };

  const conv = await core.getContext(convId);
  const messages = [{ role: 'system', content: buildSystemPrompt(cfg, { ...meta, skills, prefabList }) }];

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
    if (totalBudgetMs > 0 && Date.now() - started > totalBudgetMs) {
      log('[agent] 超出总时间预算,提前收尾');
      break;
    }
    rounds++;

    const resp = await chatWithFallback(cfg, messages, tools, { timeoutMs: perCallTimeoutMs });

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

    // 同一轮的多个工具调用并行执行(彼此独立,串行会白白浪费时间)。
    // 结果按原顺序回填,保证 tool_call_id 一一对应。
    const t0 = Date.now();
    const settled = await Promise.allSettled(calls.map(async (call) => {
      const name = call.function?.name || '';
      let args = {};
      try {
        args = JSON.parse(call.function?.arguments || '{}');
      } catch {
        args = {};
      }
      const m = mcp.map.get(name);
      const em = extTools.map.get(name);
      let result;
      if (m) result = await callMcp(core.env, m.serverId, m.tool, args);
      else if (em) result = await runExternalTool(em, args, (msg) => log(`[扩展] ${msg}`));
      else result = await executeTool(name, args, ctx);
      return { name, args, result: String(result) };
    }));

    for (let i = 0; i < calls.length; i++) {
      const call = calls[i];
      const name = call.function?.name || '';
      const s = settled[i];
      const item = s.status === 'fulfilled'
        ? s.value
        : { name, args: {}, result: `工具执行出错:${s.reason?.message || s.reason}` };
      const ms = Date.now() - t0;
      toolTrace.push({ name: item.name, args: item.args, result: truncate(item.result, 500), ms });
      log(`[工具] ${item.name} ${JSON.stringify(item.args).slice(0, 200)} -> ${ms}ms :: ${item.result.replace(/\s+/g, ' ').slice(0, 300)}`);
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        // 超长工具结果掐头去尾,上下文更紧凑,模型仍能看到关键部分
        content: clipMiddle(item.result, 2600, 1400),
      });
    }

    if (round === cfg.agentMaxRounds - 1) {
      messages.push({
        role: 'user',
        content: '现在请直接用简体中文给出最终回复,不要再调用任何工具。',
      });
      const last = await chatWithFallback(cfg, messages, null, { timeoutMs: perCallTimeoutMs });
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
