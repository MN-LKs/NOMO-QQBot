import { normaliseEvent } from './webhook.js';
import { logWrite } from '../store/logs.js';

const OP = { DISPATCH: 0, HEARTBEAT: 1, IDENTIFY: 2, RECONNECT: 7, INVALID: 9, HELLO: 10, ACK: 11 };

export function wsStatus(core) {
  return {
    connected: !!core.ws && core.wsState === 'open',
    state: core.wsState || 'stopped',
    since: core.wsSince || 0,
    lastEvent: core.wsLastEvent || 0,
    seq: core.wsSeq || 0,
    reconnects: core.wsReconnects || 0,
    note: core.wsNote || '',
  };
}

export async function wsStart(core, { force = false } = {}) {
  const log = (m, lv = 'info') => logWrite(core.env, lv, 'gateway', m);
  if (core.ws && core.wsState === 'open' && !force) return { ok: true, note: '已经连着' };
  if (core.ws) wsClose(core);

  const cfg = await core.cfg();
  if (!cfg.appId || !cfg.appSecret) {
    core.wsState = 'error';
    core.wsNote = '还没配置 APPID / AppSecret';
    return { ok: false, note: core.wsNote };
  }

  core.wsState = 'connecting';
  try {
    const token = await core.getToken(true);
    const infoRes = await fetch(cfg.gatewayUrl, {
      headers: { Authorization: `QQBot ${token}`, 'User-Agent': 'NPAPI/3.0' },
    });
    const info = await infoRes.json().catch(() => ({}));
    if (!info.url) throw new Error(`获取网关地址失败 HTTP ${infoRes.status} ${JSON.stringify(info).slice(0, 200)}`);

    const wsUrl = String(info.url).replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
    const res = await fetch(wsUrl, { headers: { Upgrade: 'websocket' } });
    const ws = res.webSocket;
    if (!ws) throw new Error(`WebSocket 握手失败 HTTP ${res.status}`);
    ws.accept();

    core.ws = ws;
    core.wsSeq = 0;
    core.wsHeartbeatMs = 30000;
    core.wsTokenAt = Date.now();
    core.wsNote = '';

    ws.addEventListener('message', (ev) => {
      try {
        handleFrame(core, JSON.parse(ev.data));
      } catch (e) {
        log(`解析帧失败:${String(e?.message || e)}`, 'warn');
      }
    });
    ws.addEventListener('close', () => {
      core.ws = null;
      core.wsState = 'closed';
      core.wsNote = '连接已断开';
      stopHeartbeat(core);
      log('WebSocket 已断开', 'warn');
      core.scheduleReconnect(3000);
    });
    ws.addEventListener('error', () => {
      log('WebSocket 出错', 'warn');
    });

    core.wsState = 'open';
    core.wsSince = Date.now();
    log(`WebSocket 已连接(${info.url.split('?')[0]})`);
    return { ok: true, note: 'WebSocket 已连接' };
  } catch (e) {
    core.ws = null;
    core.wsState = 'error';
    core.wsNote = String(e?.message || e);
    log(`WebSocket 连接失败:${core.wsNote}`, 'error');
    core.scheduleReconnect(15000);
    return { ok: false, note: core.wsNote };
  }
}

export function wsClose(core) {
  stopHeartbeat(core);
  try {
    if (core.ws) core.ws.close(1000, 'bye');
  } catch {
    /* ignore */
  }
  core.ws = null;
  core.wsState = 'stopped';
  core.wsNote = '已手动停止';
}

function stopHeartbeat(core) {
  if (core.wsTimer) {
    clearInterval(core.wsTimer);
    core.wsTimer = null;
  }
}

function send(core, obj) {
  try {
    core.ws?.send(JSON.stringify(obj));
    return true;
  } catch {
    return false;
  }
}

function startHeartbeat(core, ms) {
  stopHeartbeat(core);
  const period = Math.max(5000, Number(ms) || 30000);
  core.wsHeartbeatMs = period;
  const beat = () => send(core, { op: OP.HEARTBEAT, d: core.wsSeq || null });
  beat();
  core.wsTimer = setInterval(beat, period);
}

export async function handleFrame(core, frame) {
  const log = (m, lv = 'info') => logWrite(core.env, lv, 'gateway', m);
  switch (frame.op) {
    case OP.HELLO: {
      startHeartbeat(core, frame.d?.heartbeat_interval);
      const cfg = await core.cfg();
      send(core, {
        op: OP.IDENTIFY,
        d: { token: `QQBot ${await core.getToken(true)}`, intents: cfg.intents, shard: [0, 1], properties: {} },
      });
      log(`已发送 Identify(intents=${cfg.intents})`);
      break;
    }
    case OP.DISPATCH: {
      if (frame.s) core.wsSeq = frame.s;
      core.wsLastEvent = Date.now();
      const task = normaliseEvent({ t: frame.t, d: frame.d, id: frame.id });
      if (task.kind === 'message') {
        core.enqueue(task);
        if (task.type === 'GROUP_ADD_ROBOT' || task.type === 'FRIEND_ADD') {
          core.onJoin(task).catch(() => null);
        }
      } else if (task.kind === 'note') {
        log(`[事件] ${task.type} 已收到`);
      }
      break;
    }
    case OP.ACK:
      break;
    case OP.RECONNECT: {
      log('服务端要求重连', 'warn');
      wsClose(core);
      core.wsState = 'reconnecting';
      core.wsReconnects = (core.wsReconnects || 0) + 1;
      core.scheduleReconnect(2000);
      break;
    }
    case OP.INVALID: {
      log('会话失效,重新握手', 'warn');
      core.wsSeq = 0;
      wsClose(core);
      core.scheduleReconnect(3000);
      break;
    }
    default:
      break;
  }
}

export async function wsEnsure(core) {
  const cfg = await core.cfg();
  if (cfg.mode !== 'websocket') return { ok: true, note: '当前是 WebHook 模式,不建立 WebSocket' };
  if (core.ws && core.wsState === 'open') {
    if (Date.now() - (core.wsTokenAt || 0) > 100 * 60 * 1000) {
      core.wsReconnects = (core.wsReconnects || 0) + 1;
      wsClose(core);
      return await wsStart(core, { force: true });
    }
    return { ok: true, note: 'WebSocket 正常' };
  }
  return await wsStart(core, { force: true });
}
