export function truncate(s, n, tail = '…') {
  const str = String(s ?? '');
  if (str.length <= n) return str;
  return str.slice(0, Math.max(0, n - tail.length)) + tail;
}

/**
 * 去掉 QQ 消息开头携带的 @机器人 标记。
 * QQ 群消息的 content 可能是 "<@1DE88...> /AI 你好" 或 "<@!123> /帮助";
 * 这些标记不剥掉,parseCommand / parseAiPrefix 会把整条消息当成普通文本,
 * 表现为"机器人收到了但完全没反应"。
 */
export function stripMention(s) {
  return String(s ?? '')
    .replace(/^(?:\s*<@!?[^>]*>\s*)+/, '')
    .trim();
}

/**
 * 超长文本掐头去尾:保留开头 head 字 + 结尾 tail 字,中间折叠成一行提示。
 * 用于工具结果进上下文之前,让多轮工具调用的上下文更紧凑(用更小的空间装更多内容)。
 */
export function clipMiddle(s, head = 2600, tail = 1400) {
  const str = String(s ?? '');
  if (str.length <= head + tail + 80) return str;
  const omitted = str.length - head - tail;
  return `${str.slice(0, head)}\n…(中间省略 ${omitted} 字)…\n${str.slice(-tail)}`;
}

export function chunkText(text, size = 800, maxChunks = 5) {
  const str = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  if (!str) return [];
  if (str.length <= size) return [str];

  const chunks = [];
  let rest = str;
  while (rest.length > size && chunks.length < maxChunks - 1) {
    let cut = -1;
    const nl = rest.lastIndexOf('\n', size);
    if (nl > size * 0.5) cut = nl + 1;
    if (cut < 0) {
      for (const ch of ['。', '!', '?', ';', '.', ',', '、', ' ']) {
        const i = rest.lastIndexOf(ch, size);
        if (i > size * 0.5) {
          cut = i + 1;
          break;
        }
      }
    }
    if (cut < 0) cut = size;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) {
    if (rest.length <= size) {
      chunks.push(rest);
    } else {
      const note = `…(内容过长,还有 ${rest.length} 字没发完)`;
      chunks.push(truncate(rest, Math.max(20, size - note.length)) + note);
    }
  }
  return chunks.filter(Boolean).map((c) => c.slice(0, size + 40));
}

// 分片时 ``` 围栏很可能被切成两半,QQ 端会渲染失败(整段代码当纯文本,
// 或者后面的正文被当成代码)。这里在边界处补齐:被切开的代码块,
// 前一片补上收尾围栏,后一片补上开头围栏和语言标记。
export function sealFenceChunks(chunks) {
  if (!Array.isArray(chunks) || chunks.length < 2) return chunks;
  let inFence = false;
  let lang = '';
  for (let i = 0; i < chunks.length; i++) {
    if (!inFence) {
      // 数一下这一片开了几个围栏:奇数个说明这一片结束时仍在代码块里
      const lines = chunks[i].split('\n');
      let opened = null;
      for (const line of lines) {
        const m = /^\s*```+\s*([A-Za-z0-9+#._-]*)\s*$/.exec(line);
        if (m) {
          if (opened === null) opened = { lang: m[1] };
          else opened = null;
        }
      }
      if (opened !== null) {
        chunks[i] = chunks[i].replace(/\s+$/, '') + '\n```';
        inFence = true;
        lang = opened.lang;
      }
    } else {
      chunks[i] = '```' + (lang || '') + '\n' + chunks[i];
      // 这一片里可能有自己的收尾围栏,重新数一遍决定下一状态
      const lines = chunks[i].split('\n');
      let open = true;
      for (const line of lines) {
        if (/^\s*```+\s*[A-Za-z0-9+#._-]*\s*$/.test(line)) open = !open;
      }
      inFence = open;
      if (!inFence) lang = '';
    }
  }
  return chunks;
}

export function toPlainText(md) {
  let s = String(md ?? '');
  // 代码块:纯文本里没有等宽渲染,加一行分隔让代码段边界清楚可读
  s = s.replace(/```([a-zA-Z0-9+#-]*)\n?([\s\S]*?)```/g, (_m, _lang, code) => {
    const body = code.replace(/^\n+/, '').replace(/\n+$/, '');
    return `\n——— 代码 ———\n${body}\n——— 代码结束 ———\n`;
  });
  s = s.replace(/`([^`\n]+)`/g, '$1');
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '$1');
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,。,]|$)/g, '$1$2');
  s = s.replace(/__([^_]+)__/g, '$1');
  s = s.replace(/~~([^~]+)~~/g, '$1');
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '[图片:$1]');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1($2)');
  s = s.replace(/^\s*>\s?/gm, '');
  s = s.replace(/^\s*[-*+]\s+/gm, '· ');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

export function safeJson(s, fallback = null) {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}
