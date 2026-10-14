import { signValidation, verifyWebhook } from './sign.js';

const OK_BODY = JSON.stringify({ op: 12, d: {} });

const MESSAGE_EVENTS = new Set([
  'GROUP_AT_MESSAGE_CREATE',
  'GROUP_MESSAGE_CREATE',
  'C2C_MESSAGE_CREATE',
]);

const JOIN_EVENTS = new Set(['GROUP_ADD_ROBOT', 'FRIEND_ADD']);

const NOTED_EVENTS = new Set([
  'GROUP_DEL_ROBOT',
  'FRIEND_DEL',
  'GROUP_MSG_REJECT',
  'GROUP_MSG_RECEIVE',
  'C2C_MSG_REJECT',
  'C2C_MSG_RECEIVE',
]);

const loggedTypes = new Set();

function jsonRes(body, status = 200) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function textOf(d) {
  return String(d?.content || '').trim();
}

export function normaliseEvent(payload) {
  const t = payload?.t;
  const d = payload?.d || {};
  const base = { eventId: payload?.id, type: t, ts: Date.now() };

  if (MESSAGE_EVENTS.has(t)) {
    const isC2C = t === 'C2C_MESSAGE_CREATE';
    const groupId = d.group_openid;
    const userId = d.author?.user_openid || d.author?.member_openid || d.author?.id;
    const openId = d.author?.user_openid || d.author?.member_openid;
    return {
      ...base,
      kind: 'message',
      scene: isC2C ? 'c2c' : 'group',
      convId: isC2C ? `u:${openId}` : `g:${groupId}`,
      targetId: isC2C ? openId : groupId,
      messageId: d.id,
      userId: isC2C ? openId : userId,
      nickname: d.author?.nickname || d.author?.username || '',
      text: textOf(d),
    };
  }

  if (t === 'GROUP_ADD_ROBOT') {
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

  if (t === 'FRIEND_ADD') {
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

  if (NOTED_EVENTS.has(t)) {
    return { ...base, kind: 'note' };
  }

  return { ...base, kind: 'ignore' };
}

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

  {
    const sig = request.headers.get('X-Signature-Ed25519');
    const ts = request.headers.get('X-Signature-Timestamp');
    try {
      const r = await verifyWebhook(cfg.appSecret, sig, ts, rawBody);
      if (!r.ok) {
        console.warn(`[验签失败] ${r.reason}`);
        return jsonRes({ error: 'signature invalid' }, 401);
      }
    } catch (e) {
      console.error('[验签异常]', e?.stack || e);
      return jsonRes({ error: 'signature error' }, 401);
    }
  }

  if (payload.op !== 0) {
    return new Response(OK_BODY, { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  const task = normaliseEvent(payload);

  if (task.kind !== 'message') {
    if (task.kind === 'note') {
      console.log(`[事件] ${task.type} 已收到(无需回复)`);
    } else if (task.type && !loggedTypes.has(task.type)) {
      loggedTypes.add(task.type);
      console.log(`[事件] 未处理的类型:${task.type}(已忽略,如需支持请告知)`);
    }
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
  }).catch((e) => {
    console.error('[入队失败]', e?.stack || e);
    throw e;
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
