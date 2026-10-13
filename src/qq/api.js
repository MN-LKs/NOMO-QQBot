const UA = 'NPAPI/1.0';

export const ERR_URL_FORBIDDEN = 40054010;
export const ERR_TOO_LONG = 40054007;
export const ERR_ACTIVE_NO_PERMISSION = 40034105;
export const ERR_PASSIVE_EXPIRED = 40034128;

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

export function sendGroupMessage(cfg, token, o) {
  const body = { msg_type: 0, content: String(o.content) };
  if (o.msgId) body.msg_id = o.msgId;
  if (o.msgSeq !== undefined) body.msg_seq = o.msgSeq;
  return post(cfg, token, `/v2/groups/${encodeURIComponent(o.groupOpenid)}/messages`, body);
}

export function sendC2CMessage(cfg, token, o) {
  const body = { msg_type: 0, content: String(o.content) };
  if (o.msgId) body.msg_id = o.msgId;
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

function sendOne(cfg, token, target, content, { mode, msgId, msgSeq }) {
  if (mode === 'active') {
    return target.kind === 'group'
      ? sendActiveGroupMessage(cfg, token, target.id, content)
      : sendActiveC2CMessage(cfg, token, target.id, content);
  }
  return target.kind === 'group'
    ? sendGroupMessage(cfg, token, { groupOpenid: target.id, content, msgId, msgSeq })
    : sendC2CMessage(cfg, token, { openid: target.id, content, msgId, msgSeq });
}

export async function deliver(cfg, token, target, opts = {}) {
  const { chunks, chunkSize = 800, msgId } = opts;
  const mode = opts.mode === 'active' ? 'active' : 'passive';
  const sent = [];
  const errors = [];
  let seq = opts.msgSeqStart || 1;

  for (const raw of chunks) {
    let content = raw;
    let r = await sendOne(cfg, token, target, content, { mode, msgId, msgSeq: seq });

    if (!r.ok && r.data?.code === ERR_URL_FORBIDDEN) {
      const stripped = content.replace(/https?:\/\//g, '');
      if (stripped !== content) {
        const r2 = await sendOne(cfg, token, target, stripped, { mode, msgId, msgSeq: seq });
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
        const r3 = await sendOne(cfg, token, target, piece, { mode, msgId, msgSeq: seq });
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

function chunkRaw(text, size) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}
