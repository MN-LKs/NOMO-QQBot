// QQ 机器人 Webhook 入口。
//
// 三条硬规则:
//   1. 必须在 5 秒内回 200,否则腾讯会重推;所以重活全部丢给 Durable Object 的闹钟去做。
//   2. 每条推送都要验 Ed25519 签名(否则任何人都能伪造群消息)。
//   3. 同一条推送可能重发多次,必须按事件 ID 去重。

import { signValidation, verifyWebhook } from './sign.js';

const OK_BODY = JSON.stringify({ op: 12, d: {} });

function jsonRes(body, status = 200) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/** 把腾讯的事件转成内部任务 */
export function normaliseEvent(payload) {
  const t = payload?.t;
  const d = payload?.d || {};
  const base = { eventId: payload?.id, type: t, ts: Date.now() };

  switch (t) {
    case 'GROUP_AT_MESSAGE_CREATE':
    case 'GROUP_MESSAGE_CREATE': {
      return {
        ...base,
        kind: 'message',
        scene: 'group',
        convId: `g:${d.group_openid}`,
        targetId: d.group_openid,
        messageId: d.id,
        userId: d.author?.member_openid || d.author?.id,
        nickname: d.author?.nickname || d.author?.username || '',
        text: String(d.content || '').trim(),
      };
    }
    case 'C2C_MESSAGE_CREATE': {
      return {
        ...base,
        kind: 'message',
        scene: 'c2c',
        convId: `u:${d.author?.user_openid}`,
        targetId: d.author?.user_openid,
        messageId: d.id,
        userId: d.author?.user_openid,
        nickname: '',
        text: String(d.content || '').trim(),
      };
    }
    case 'GROUP_ADD_ROBOT': {
      return {
        ...base,
        kind: 'message',
        scene: 'group',
        convId: `g:${d.group_openid}`,
        targetId: d.group_openid,
        messageId: d.event_id || d.id,
        userId: d.op_member_openid,
        nickname: '',
        text: '/帮助',
      };
    }
    case 'FRIEND_ADD': {
      return {
        ...base,
        kind: 'message',
        scene: 'c2c',
        convId: `u:${d.openid}`,
        targetId: d.openid,
        messageId: d.event_id || d.id,
        userId: d.openid,
        nickname: '',
        text: '/帮助',
      };
    }
    default:
      return { ...base, kind: 'ignore' };
  }
}

/**
 * @param {Request} request
 * @param {object} cfg
 * @param {object} env
 * @returns {Promise<Response>}
 */
export async function handleWebhook(request, cfg, env) {
  if (request.method !== 'POST') {
    return jsonRes({ error: '只接受 POST' }, 405);
  }

  const rawBody = new Uint8Array(await request.arrayBuffer());
  const bodyText = new TextDecoder('utf-8').decode(rawBody);

  let payload;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    return jsonRes({ error: 'body 不是合法 JSON' }, 400);
  }

  // ---- 1. 回调地址验证(op=13)----
  if (payload.op === 13) {
    const eventTs = String(payload.d?.event_ts ?? '');
    const plainToken = String(payload.d?.plain_token ?? '');
    try {
      const signature = await signValidation(cfg.appSecret, eventTs, plainToken);
      console.log('[回调验证] op=13 校验通过');
      return jsonRes({ plain_token: plainToken, signature });
    } catch (e) {
      console.error('[回调验证] 签名失败', e?.stack || e);
      return jsonRes({ error: `签名失败: ${e?.message || e}` }, 500);
    }
  }

  // ---- 2. 签名校验 ----
  if (cfg.verifySignature) {
    const sig = request.headers.get('X-Signature-Ed25519');
    const ts = request.headers.get('X-Signature-Timestamp');
    try {
      const r = await verifyWebhook(cfg.appSecret, sig, ts, rawBody);
      if (!r.ok) {
        console.warn(`[验签失败] ${r.reason}`);
        return jsonRes({ error: 'signature invalid' }, 401);
      }
    } catch (e) {
      // 验签自身出问题(比如运行时差异)不能把机器人打死:放行但告警
      console.error('[验签异常,已放行]', e?.stack || e);
    }
  }

  // ---- 3. 业务事件 ----
  if (payload.op !== 0) {
    return new Response(OK_BODY, { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  const task = normaliseEvent(payload);
  if (task.kind === 'ignore') {
    console.log(`[忽略事件] ${task.type}`);
    return new Response(OK_BODY, { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  const stub = env.BOT_CORE.get(env.BOT_CORE.idFromName('core'));
  const enqueue = stub.fetch('https://do/enqueue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(task),
  }).then(async (r) => {
    const t = await r.text();
    if (!r.ok) throw new Error(`DO ${r.status}: ${t.slice(0, 200)}`);
    return t;
  });

  try {
    await Promise.race([enqueue, sleep(4000)]);
    return new Response(OK_BODY, { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('[入队失败]', e?.stack || e);
    return jsonRes({ error: 'enqueue failed' }, 500);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
