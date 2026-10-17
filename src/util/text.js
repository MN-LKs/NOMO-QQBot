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

export function toPlainText(md) {
  let s = String(md ?? '');
  s = s.replace(/```([a-zA-Z0-9+#-]*)\n?([\s\S]*?)```/g, (_m, _lang, code) => code.replace(/\n+$/, ''));
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
