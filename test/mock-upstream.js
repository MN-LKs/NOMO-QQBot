import http from 'node:http';

export function startMock({ llmPort = 8790 } = {}) {
  const calls = { chat: 0, qqSend: [], qqToken: 0, llmBodies: [] };
  const flags = { breakChat: 0, emptyAnswer: 0, longAnswer: null, rejectUrl: 0, rejectActive: 0, plainAnswer: 0, rejectPassive: 0 };

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/app/getAppAccessToken') {
      calls.qqToken++;
      return json(res, { access_token: 'MOCK_TOKEN', expires_in: '7200' });
    }

    if (/^\/v2\/(groups|users)\/[^/]+\/messages$/.test(url.pathname)) {
      let body = {};
      try { body = JSON.parse(raw); } catch { /* ignore */ }
      calls.qqSend.push({ path: url.pathname, body });
      const isActive = !body.msg_id;
      if (!isActive && flags.rejectPassive > 0) {
        flags.rejectPassive--;
        return json(res, { code: 40034128, message: '被动回复时间或次数超限' }, 400);
      }
      if (isActive && flags.rejectActive > 0) {
        flags.rejectActive--;
        return json(res, { code: 40034105, message: '主动消息无权限' }, 400);
      }
      if (flags.rejectUrl > 0 && /https?:\/\//.test(String(body.content))) {
        flags.rejectUrl--;
        return json(res, { code: 40054010, message: '不允许发送URL' }, 400);
      }
      return json(res, { id: `MSG_${calls.qqSend.length}`, timestamp: new Date().toISOString() });
    }

    if (url.pathname === '/v1/models') {
      return json(res, { data: [{ id: 'deepseek-v4.1-flash', object: 'model' }] });
    }

    if (url.pathname === '/dashboard') {
      return json(res, {
        data: {
          realtime: {
            all_quota: 1000000, all_requests: 42, all_tokens: 123456,
            last300_req: 3, last300_tokens: 900, last60_req: 1, last60_tokens: 300, last300_active_users: 2,
          },
          recent: [{ id: 1, model_name: 'deepseek-v4.1-flash', tokens: 500, username: 'tester' }],
        },
      });
    }

    if (url.pathname === '/search') {
      return json(res, {
        results: [
          { title: '搜索结果一', url: 'https://example.com/one', content: '这是第一条摘要' },
          { title: '搜索结果二', url: 'https://example.com/two', content: '这是第二条摘要' },
        ],
      });
    }

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
      const toolResults = (body.messages || []).filter((m) => m.role === 'tool');

      if (!hasTools) {
        return json(res, completion({
          reasoning: '这是一次压缩请求,直接给摘要。',
          content: '用户想做一个 2048 游戏,已经部署成功,偏好简洁回复。',
          usage: { total: 30, reasoning: 12 },
        }));
      }

      if (toolResults.length > 0) {
        if (flags.emptyAnswer > 0) {
          flags.emptyAnswer--;
          return json(res, completion({ finish: 'stop', usage: { total: 10, reasoning: 5 } }));
        }
        if (flags.longAnswer !== null) {
          const long = flags.longAnswer;
          flags.longAnswer = null;
          return json(res, completion({ content: long, finish: 'stop', usage: { total: 900, reasoning: 20 } }));
        }
        const lastTool = toolResults[toolResults.length - 1].content || '';
        const m = /https?:\/\/[^\s]+/.exec(lastTool);
        const link = m ? m[0] : '(没有链接)';
        const echo = lastTool.slice(0, 400);
        return json(res, completion({
          reasoning: '工具已经返回,直接总结给用户。',
          content: `搞定啦!👉 ${link}\n直接点开就能玩,键盘方向键控制。\n[工具回执] ${echo}`,
          usage: { total: 80, reasoning: 40 },
        }));
      }

      if (flags.plainAnswer > 0) {
        flags.plainAnswer--;
        return json(res, completion({
          reasoning: '直接回答,不需要工具。',
          content: '好的,收到啦。',
          usage: { total: 20, reasoning: 5 },
        }));
      }

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
      return json(res, completion({
        reasoning: '用户要一个网页,我应该用 deploy_site 工具部署出去。',
        toolCalls: [{ id: 'call_test_1', type: 'function', function: { name: 'deploy_site', arguments: args } }],
        finish: 'tool_calls',
        usage: { total: 120, reasoning: 60 },
      }));
    }

    return json(res, { error: 'mock: not found', path: url.pathname }, 404);
  });

  return new Promise((resolve) => {
    server.listen(llmPort, '127.0.0.1', () => resolve({
      server,
      calls,
      flags,
      breakOnce: (n = 1) => { flags.breakChat += Number(n) || 1; },
      emptyOnce: () => { flags.emptyAnswer++; },
      longOnce: (text) => { flags.longAnswer = text; },
      rejectUrlOnce: () => { flags.rejectUrl++; },
      rejectActiveOnce: (n = 1) => { flags.rejectActive += n; },
      plainNext: (n = 1) => { flags.plainAnswer += n; },
      rejectPassiveOnce: (n = 1) => { flags.rejectPassive += n; },
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

function json(res, obj, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function completion({ content = '', reasoning = '', toolCalls = null, finish = 'stop', usage = {} }) {
  const message = { role: 'assistant', content };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls) message.tool_calls = toolCalls;
  return {
    id: 'mock',
    object: 'chat.completion',
    model: 'deepseek-v4.1-flash',
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: { total_tokens: usage.total ?? 0, completion_thinking_tokens: usage.reasoning ?? 0 },
  };
}
