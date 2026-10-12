// 文本处理:分块、清理 Markdown、截断。纯函数,方便单测。

/** 按字符数截断,尾部加省略号 */
export function truncate(s, n, tail = '…') {
  const str = String(s ?? '');
  if (str.length <= n) return str;
  return str.slice(0, Math.max(0, n - tail.length)) + tail;
}

/**
 * 把长文本切成若干块发给 QQ。
 * 优先在换行处断开,避免把代码/句子劈成两半。
 */
export function chunkText(text, size = 800, maxChunks = 5) {
  const str = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  if (!str) return [];
  if (str.length <= size) return [str];

  const chunks = [];
  let rest = str;
  while (rest.length > size && chunks.length < maxChunks - 1) {
    let cut = -1;
    // 先找 size 之前最后一个换行
    const nl = rest.lastIndexOf('\n', size);
    if (nl > size * 0.5) cut = nl + 1;
    if (cut < 0) {
      // 退而求其次:找句号/问号/感叹号/分号
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
      // 分块数量已经到上限:最后一块截断,并明确告诉用户还有多少没发出来
      const note = `…(内容过长,还有 ${rest.length} 字没发完)`;
      chunks.push(truncate(rest, Math.max(20, size - note.length)) + note);
    }
  }
  return chunks.filter(Boolean).map((c) => c.slice(0, size + 40));
}

/**
 * QQ 纯文本消息里 Markdown 很吵,做一次轻量清洗。
 * 只做「无损可读」的转换,不试图做完整 Markdown 渲染。
 */
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

/** 统计「大概多少 token」:中文按 1 字 1 token,英文按 4 字符 1 token 粗估 */
export function roughTokens(s) {
  const str = String(s ?? '');
  let cjk = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c >= 0x2e80 && c <= 0x9fff) cjk++;
  }
  const other = str.length - cjk;
  return cjk + Math.ceil(other / 4);
}

/** 安全 JSON.parse */
export function safeJson(s, fallback = null) {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

/** 从一段文本里抽出所有 http(s) 链接 */
export function findUrls(s) {
  return String(s ?? '').match(/https?:\/\/[^\s<>"'()\[\]]+/g) || [];
}
