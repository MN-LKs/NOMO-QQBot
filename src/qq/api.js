// QQ 机器人 OpenAPI 客户端(只用到发消息 / 拿 token 这两类)。
// 文档:https://bot.q.qq.com/wiki/develop/api-v2/

const UA = 'QQBot-NB-API/1.0 (+cloudflare-workers)';

/** 拿 app access_token。7200 秒有效期,过期前 60 秒内取会拿到新的。 */
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
    // 提前 5 分钟过期,避免边界情况
    expiresAt: Date.now() + (Number.isFinite(expiresIn) ? expiresIn : 7200) * 1000 - 300000,
  };
}

function headers(cfg, token) {
  // 官方文档只要求 Authorization: QQBot <token>,不要画蛇添足加别的头
  return {
    'Authorization': `QQBot ${token}`,
    'Content-Type': 'application/json',
    'User-Agent': UA,
  };
}

async function post(cfg, token, path, body) {
  const res = await fetch(cfg.apiBase + path, {
    method: 'POST',
    headers: headers(cfg, token),
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

/**
 * 发群聊消息。
 * @param {object} o
 * @param {string} o.groupOpenid
 * @param {string} o.content
 * @param {string} [o.msgId]  被动回复必须带(msg_id 来自消息事件)
 * @param {number} [o.msgSeq] 被动回复的序号,同一条 msg_id 每次必须不同,否则 40054005 去重
 */
export function sendGroupMessage(cfg, token, o) {
  const body = { msg_type: 0, content: String(o.content) };
  if (o.msgId) body.msg_id = o.msgId;
  if (o.msgSeq !== undefined) body.msg_seq = o.msgSeq;
  return post(cfg, token, `/v2/groups/${encodeURIComponent(o.groupOpenid)}/messages`, body);
}

/** 发单聊(C2C)消息 */
export function sendC2CMessage(cfg, token, o) {
  const body = { msg_type: 0, content: String(o.content) };
  if (o.msgId) body.msg_id = o.msgId;
  if (o.msgSeq !== undefined) body.msg_seq = o.msgSeq;
  return post(cfg, token, `/v2/users/${encodeURIComponent(o.openid)}/messages`, body);
}

/** 主动消息(不需要 msg_id,受频控限制) */
export function sendGroupActive(cfg, token, groupOpenid, content) {
  return post(cfg, token, `/v2/groups/${encodeURIComponent(groupOpenid)}/messages`, {
    msg_type: 0,
    content: String(content),
  });
}

/** QQ 返回「不允许发送 URL」 */
export const ERR_URL_FORBIDDEN = 40054010;
/** 消息长度超限 */
export const ERR_TOO_LONG = 40054007;
/** 消息被去重(msg_seq 没变) */
export const ERR_DEDUP = 40054005;
/** 被动回复时间/次数超限 */
export const ERR_PASSIVE_LIMIT = 40034128;

/** 给用户看的错误解释 */
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
    40034105: '主动消息无权限',
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

/**
 * 把一条长回复拆开发出去。返回实际发出的条数与失败原因。
 * 针对 40054010(不许发 URL)会自动降级:去掉协议头再试一次。
 */
export async function deliver(cfg, token, target, text, opts = {}) {
  const { chunks, chunkSize = 800, maxChunks = 5, msgId } = opts;
  const list = chunks;
  const sent = [];
  const errors = [];
  let seq = opts.msgSeqStart || 1;

  for (const raw of list) {
    let content = raw;
    let r = await send(target, content, seq);
    if (!r.ok && r.data?.code === ERR_URL_FORBIDDEN) {
      // 腾讯不让发 URL:把 https:// 去掉,多数情况能过
      const stripped = content.replace(/https?:\/\//g, '');
      if (stripped !== content) {
        const r2 = await send(target, stripped, seq);
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
      // 再切一半重试一次
      const half = chunkSize >> 1;
      let ok = true;
      for (const piece of chunkRaw(content, half)) {
        const r3 = await send(target, piece, seq);
        seq++;
        if (r3.ok) sent.push(piece);
        else {
          ok = false;
          errors.push(explainError(r3.data));
          break;
        }
      }
      if (ok) continue;
    }
    if (r.ok) {
      sent.push(content);
      seq++;
    } else {
      errors.push(explainError(r.data));
    }
  }

  async function send(which, content, s) {
    if (which.kind === 'group') {
      return sendGroupMessage(cfg, token, { groupOpenid: which.id, content, msgId, msgSeq: s });
    }
    return sendC2CMessage(cfg, token, { openid: which.id, content, msgId, msgSeq: s });
  }

  return { sent, errors };
}

function chunkRaw(text, size) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}
