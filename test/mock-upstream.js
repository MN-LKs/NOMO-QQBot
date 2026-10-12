// 集成测试用的假上游:同时扮演「大模型网关」和「QQ 开放平台」。
// 这样端到端测试完全不碰外网,也不会消耗任何额度。

import http from 'node:http';

export function startMock({ llmPort = 8790 } = {}) {
  const calls = { chat: 0, qqSend: [], qqToken: 0, llmBodies: [] };
  // 故障注入开关
  const flags = { breakChat: 0, emptyAnswer: 0, longAnswer: null, rejectUrl: 0 };

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url, 'http://localhost');

    // ---------- QQ: 取 token ----------
    if (url.pathname === '/app/getAppAccessToken') {
      calls.qqToken++;
      return json(res, { access_token: 'MOCK_TOKEN', expires_in: '7200' });
    }

    // ---------- QQ: 发消息 ----------
    if (/^\/v2\/(groups|users)\/[^/]+\/messages$/.test(url.pathname)) {
      let body = {};
      try { body = JSON.parse(raw); } catch { /* ignore */ }
      calls.qqSend.push({ path: url.pathname, body });
      // 故障注入:含 URL 的消息第一次会被腾讯以 40054010 拒掉
      if (flags.rejectUrl > 0 && /https?:\/\//.test(String(body.content))) {
        flags.rejectUrl--;
        return json(res, { code: 40054010, message: '不允许发送URL' }, 400);
      }
      return json(res, { id: `MSG_${calls.qqSend.length}`, timestamp: new Date().toISOString() });
    }

    // ---------- 模型:模型列表 ----------
    if (url.pathname === '/v1/models') {
      return json(res, { data: [{ id: 'deepseek-v4.1-flash', object: 'model' }] });
    }

    // ---------- 模型:对话 ----------
    if (url.pathname === '/v1/chat/completions') {
      calls.chat++;
      if (flags.breakChat > 0) {
        flags.breakChat--;
        res.writeHead(504, { 'Content-Type': 'text/plain' });
        return res.end('error code: 504');
      }
      let body = {};
      try { body = JSON.parse(raw); } catch { /* ignore */ }
      calls.llmBodies.push(body);

      const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
      const last = body.messages?.[body.messages.length - 1];
      const toolResults = (body.messages || []).filter((m) => m.role === 'tool');
      const deployCount = calls.llmBodies.filter((b) => b.messages?.some?.((m) => m.role === 'tool')).length;

      // 1) 没有工具 -> 纯文本(用于 /压缩 和最后的收尾)
      if (!hasTools) {
        return sse(res, [
          chunk({ reasoning_content: '这是一次压缩请求,直接给摘要。' }),
          chunk({ content: '用户想做一个 2048 游戏,已经部署成功,偏好简洁回复。' }),
          finish('stop'),
          usageChunk(30, 12),
          '[DONE]',
        ]);
      }

      // 2) 已经有工具结果 -> 给最终答复
      if (toolResults.length > 0) {
        if (flags.emptyAnswer > 0) {
          flags.emptyAnswer--;
          return sse(res, [finish('stop'), usageChunk(10, 5), '[DONE]']);
        }
        if (flags.longAnswer !== null) {
          const long = flags.longAnswer;
          flags.longAnswer = null;
          return sse(res, [chunk({ content: long }), finish('stop'), usageChunk(900, 20), '[DONE]']);
        }
        const lastTool = toolResults[toolResults.length - 1].content || '';
        const m = /https?:\/\/[^\s]+/.exec(lastTool);
        const link = m ? m[0] : '(没有链接)';
        // 把工具结果原样带一段出去,好让测试能验证「淘汰提示」这类信息真的传到了群里
        const echo = lastTool.slice(0, 400);
        return sse(res, [
          chunk({ reasoning_content: '工具已经返回,直接总结给用户。' }),
          chunk({ content: `搞定啦!👉 ${link}\n直接点开就能玩,键盘方向键控制。\n[工具回执] ${echo}` }),
          finish('stop'),
          usageChunk(80, 40),
          '[DONE]',
        ]);
      }

      // 3) 第一轮:调用 deploy_site
      const n = calls.chat;
      const args = JSON.stringify({
        name: `测试项目${n}`,
        description: '集成测试自动部署',
        files: [{
          path: 'index.html',
          content: `<!doctype html><html><head><meta charset="utf-8"><title>测试${n}</title></head>`
            + `<body><h1>项目 ${n}</h1><script>console.log(${n})</script></body></html>`,
        }],
      });
      return sse(res, [
        chunk({ reasoning_content: '用户要一个网页,我应该用 deploy_site 工具部署出去。' }),
        toolCallChunk(0, 'call_test_1', 'deploy_site', args.slice(0, 20)),
        toolCallChunk(0, '', '', args.slice(20)),
        finish('tool_calls'),
        usageChunk(120, 60),
        '[DONE]',
      ]);
    }

    return json(res, { error: 'mock: not found', path: url.pathname }, 404);
  });

  return new Promise((resolve) => {
    server.listen(llmPort, '127.0.0.1', () => resolve({
      server,
      calls,
      flags,
      breakOnce: (n = 1) => { flags.breakChat += n; },
      emptyOnce: () => { flags.emptyAnswer++; },
      longOnce: (text) => { flags.longAnswer = text; },
      rejectUrlOnce: () => { flags.rejectUrl++; },
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

function json(res, obj, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function sse(res, lines) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  for (const l of lines) res.write(`data: ${l}\n\n`);
  res.end();
}

function chunk(delta) {
  return JSON.stringify({ id: 'mock', model: 'deepseek-v4.1-flash', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: '', reasoning_content: '', ...delta }, finish_reason: '' }] });
}
function toolCallChunk(index, id, name, argsPart) {
  const fn = {};
  if (name) fn.name = name;
  fn.arguments = argsPart;
  const tc = { index, function: fn };
  if (id) { tc.id = id; tc.type = 'function'; }
  return JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: '', reasoning_content: '', tool_calls: [tc] }, finish_reason: '' }] });
}
function finish(reason) {
  return JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: reason }] });
}
function usageChunk(total, reasoning) {
  return JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', choices: [], usage: { total_tokens: total, completion_thinking_tokens: reasoning } });
}
