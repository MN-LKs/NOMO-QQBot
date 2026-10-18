const UA = 'NOMO-QQBot/4.0';

export const ERR_URL_FORBIDDEN = 40054010;
export const ERR_TOO_LONG = 40054007;

export async function fetchAccessToken(cfg) {
  const res = await fetch(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({ appId: cfg.appId, clientSecret: cfg.appSecret }),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`getAppAccessToken 返回非 JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  if (!data.access_token) {
    throw new Error(`getAppAccessToken 失败: ${text.slice(0, 300)}`);
  }
  const expiresIn = parseInt(data.expires_in, 10);
  return {
    token: data.access_token,
    expiresAt: Date.now() + (Number.isFinite(expiresIn) ? expiresIn : 7200) * 1000 - 300000,
  };
}

function headers(token) {
  return {
    'Authorization': `QQBot ${token}`,
    'Content-Type': 'application/json',
    'User-Agent': UA,
  };
}

async function post(cfg, token, path, body) {
  const res = await fetch(cfg.apiBase + path, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text.slice(0, 300) };
  }
  return { ok: res.ok, status: res.status, data };
}

async function del(cfg, token, path) {
  const res = await fetch(cfg.apiBase + path, {
    method: 'DELETE',
    headers: headers(token),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text.slice(0, 300) };
  }
  return { ok: res.ok, status: res.status, data };
}

export function sendGroupMessage(cfg, token, o) {
  const body = { msg_type: 0, content: String(o.content) };
  if (o.eventId) body.event_id = o.eventId;
  else if (o.msgId) body.msg_id = o.msgId;
  if (o.msgSeq !== undefined) body.msg_seq = o.msgSeq;
  return post(cfg, token, `/v2/groups/${encodeURIComponent(o.groupOpenid)}/messages`, body);
}

export function sendGroupMarkdown(cfg, token, o) {
  const body = { msg_type: 2, markdown: { content: String(o.content) } };
  if (o.keyboard) body.keyboard = o.keyboard;
  if (o.eventId) body.event_id = o.eventId;
  else if (o.msgId) body.msg_id = o.msgId;
  if (o.msgSeq !== undefined) body.msg_seq = o.msgSeq;
  return post(cfg, token, `/v2/groups/${encodeURIComponent(o.groupOpenid)}/messages`, body);
}

export function sendC2CMessage(cfg, token, o) {
  const body = { msg_type: 0, content: String(o.content) };
  if (o.eventId) body.event_id = o.eventId;
  else if (o.msgId) body.msg_id = o.msgId;
  if (o.msgSeq !== undefined) body.msg_seq = o.msgSeq;
  return post(cfg, token, `/v2/users/${encodeURIComponent(o.openid)}/messages`, body);
}

export function sendC2CMarkdown(cfg, token, o) {
  const body = { msg_type: 2, markdown: { content: String(o.content) } };
  if (o.keyboard) body.keyboard = o.keyboard;
  if (o.eventId) body.event_id = o.eventId;
  else if (o.msgId) body.msg_id = o.msgId;
  if (o.msgSeq !== undefined) body.msg_seq = o.msgSeq;
  return post(cfg, token, `/v2/users/${encodeURIComponent(o.openid)}/messages`, body);
}

export function sendActiveGroupMessage(cfg, token, groupOpenid, content) {
  return post(cfg, token, `/v2/groups/${encodeURIComponent(groupOpenid)}/messages`, {
    msg_type: 0,
    content: String(content),
  });
}

export function sendActiveC2CMessage(cfg, token, openid, content) {
  return post(cfg, token, `/v2/users/${encodeURIComponent(openid)}/messages`, {
    msg_type: 0,
    content: String(content),
  });
}

export function explainError(data) {
  const code = data?.code;
  const map = {
    22006: '消息类型与内容不匹配',
    304036: '没有 Markdown 模板权限',
    304103: '消息 ID 已过期,不能回复',
    40034004: '富媒体转存失败',
    40034005: '回复的消息 ID 已过期',
    40034006: '消息内容违规',
    40034024: 'msg_id 无效或越权',
    40034026: 'event_id 已过期',
    40034027: '该事件不支持回复消息',
    40034101: '机器人不是群成员',
    40034105: '主动消息无权限(需要先在 QQ 开放平台申请)',
    40034127: '没有 Markdown 模板权限',
    40034128: '被动回复时间或次数超限(5 分钟 / 最多 5 条)',
    40054002: '机器人被禁言',
    40054003: '机器人不是群成员',
    40054005: '消息被去重(msg_seq 必须每次不同)',
    40054007: '消息长度超限',
    40054010: '不允许发送 URL',
    40054016: '机器人已下线',
  };
  if (code === undefined || code === null) return data?.message || '未知错误';
  return `${code} ${map[code] || data?.message || ''}`.trim();
}

function sendOne(cfg, token, target, content, { mode, msgId, msgSeq, eventId, markdown = false }) {
  if (mode === 'active') {
    if (markdown) {
      return target.kind === 'group'
        ? sendGroupMarkdown(cfg, token, { groupOpenid: target.id, content })
        : sendC2CMarkdown(cfg, token, { openid: target.id, content });
    }
    return target.kind === 'group'
      ? sendActiveGroupMessage(cfg, token, target.id, content)
      : sendActiveC2CMessage(cfg, token, target.id, content);
  }
  if (markdown) {
    return target.kind === 'group'
      ? sendGroupMarkdown(cfg, token, { groupOpenid: target.id, content, msgId, msgSeq, eventId })
      : sendC2CMarkdown(cfg, token, { openid: target.id, content, msgId, msgSeq, eventId });
  }
  return target.kind === 'group'
    ? sendGroupMessage(cfg, token, { groupOpenid: target.id, content, msgId, msgSeq, eventId })
    : sendC2CMessage(cfg, token, { openid: target.id, content, msgId, msgSeq, eventId });
}

export async function deliver(cfg, token, target, opts = {}) {
  const { chunks, chunkSize = 800, msgId, eventId } = opts;
  const mode = opts.mode === 'active' ? 'active' : 'passive';
  const sent = [];
  const errors = [];
  let seq = opts.msgSeqStart || 1;

  for (const raw of chunks) {
    let content = raw;
    let r;
    if (opts.markdown) {
      r = await sendOne(cfg, token, target, content, { mode, msgId, msgSeq: seq, eventId, markdown: true });
      if (!r.ok) {
        errors.push('Markdown 发送失败,已退回纯文本');
        r = await sendOne(cfg, token, target, content, { mode, msgId, msgSeq: seq, eventId });
      }
    } else {
      r = await sendOne(cfg, token, target, content, { mode, msgId, msgSeq: seq, eventId });
    }

    if (!r.ok && r.data?.code === ERR_URL_FORBIDDEN) {
      const stripped = content.replace(/https?:\/\//g, '');
      if (stripped !== content) {
        const r2 = await sendOne(cfg, token, target, stripped, { mode, msgId, msgSeq: seq, eventId });
        if (r2.ok) {
          sent.push(stripped);
          errors.push('URL 被拦截,已去掉 https:// 后发出');
          seq++;
          continue;
        }
        r = r2;
      }
    }

    if (!r.ok && r.data?.code === ERR_TOO_LONG) {
      const half = Math.max(50, chunkSize >> 1);
      let allOk = true;
      for (const piece of chunkRaw(content, half)) {
        const r3 = await sendOne(cfg, token, target, piece, { mode, msgId, msgSeq: seq, eventId });
        seq++;
        if (r3.ok) sent.push(piece);
        else {
          allOk = false;
          errors.push(explainError(r3.data));
          break;
        }
      }
      if (allOk) continue;
    }

    if (r.ok) {
      sent.push(content);
      seq++;
    } else {
      errors.push(explainError(r.data));
    }
  }

  return { sent, errors, mode };
}

function bytesToBase64(bytes) {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

export async function uploadMedia(cfg, token, target, { fileType = 1, bytes, fileName = '', url = '' } = {}) {
  const path = target.kind === 'group'
    ? `/v2/groups/${encodeURIComponent(target.id)}/files`
    : `/v2/users/${encodeURIComponent(target.id)}/files`;
  const body = {
    file_type: Number(fileType) || 1,
    srv_send_msg: false,
  };
  if (url) body.url = String(url);
  else body.file_data = bytesToBase64(bytes || new Uint8Array(0));
  if (fileName) body.file_name = String(fileName).slice(0, 120);
  return await post(cfg, token, path, body);
}

export async function sendMediaMessage(cfg, token, target, { fileInfo, msgId, msgSeq, mode = 'passive' } = {}) {
  const body = { msg_type: 7, media: { file_info: String(fileInfo || '') } };
  if (mode !== 'active') {
    if (msgId) body.msg_id = msgId;
    if (msgSeq) body.msg_seq = msgSeq;
  }
  const path = target.kind === 'group'
    ? `/v2/groups/${encodeURIComponent(target.id)}/messages`
    : `/v2/users/${encodeURIComponent(target.id)}/messages`;
  return await post(cfg, token, path, body);
}

export async function deliverMedia(cfg, token, target, media, opts = {}) {
  const up = await uploadMedia(cfg, token, target, media);
  if (!up.ok || !up.data?.file_info) {
    return { ok: false, error: explainError(up.data), fileInfo: '' };
  }
  const r = await sendMediaMessage(cfg, token, target, {
    fileInfo: up.data.file_info,
    msgId: opts.msgId,
    msgSeq: opts.msgSeq,
    mode: opts.mode,
  });
  return {
    ok: r.ok,
    error: r.ok ? '' : explainError(r.data),
    fileInfo: up.data.file_info,
  };
}

export async function muteGroupMember(cfg, token, groupOpenid, memberOpenid, seconds = 600) {
  const sec = Math.max(1, Math.min(30 * 24 * 3600, Number(seconds) || 600));
  const expire = new Date(Date.now() + sec * 1000).toISOString();
  return await post(cfg, token, `/v2/groups/${encodeURIComponent(groupOpenid)}/restrict_chat_setting`, {
    members: [{ op: 'add', member_openid: String(memberOpenid), mute_expire_at: expire }],
  });
}

export async function unmuteGroupMember(cfg, token, groupOpenid, memberOpenid) {
  return await post(cfg, token, `/v2/groups/${encodeURIComponent(groupOpenid)}/restrict_chat_setting`, {
    members: [{ op: 'remove', member_openid: String(memberOpenid) }],
  });
}

// 撤回机器人自己发的消息。
// 官方限制:发送超过 2 分钟的消息不能撤回;接口频率 10 QPS。
// messageId 用的是发送接口回包里的 id(不是 msg_id)。
export async function recallGroupMessage(cfg, token, groupOpenid, messageId) {
  if (!messageId) return { ok: false, error: '缺少 message_id' };
  return await del(cfg, token, `/v2/groups/${encodeURIComponent(groupOpenid)}/messages/${encodeURIComponent(messageId)}`);
}

export async function recallC2CMessage(cfg, token, openid, messageId) {
  if (!messageId) return { ok: false, error: '缺少 message_id' };
  return await del(cfg, token, `/v2/users/${encodeURIComponent(openid)}/messages/${encodeURIComponent(messageId)}`);
}

export async function recallMessage(cfg, token, scene, targetId, messageId) {
  if (!messageId) return { ok: false, error: '缺少 message_id' };
  return scene === 'c2c'
    ? recallC2CMessage(cfg, token, targetId, messageId)
    : recallGroupMessage(cfg, token, targetId, messageId);
}

function chunkRaw(text, size) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}
