// QQ 机器人 WebSocket 网关客户端。
//
// 状态:备用实现,目前没有接进 Durable Object(config 里 GATEWAY_MODE 默认 webhook,
//       所以下面这条链路不会启动)。要用的话需要在 do.js 里实例化并接到闹钟上。
//
// 和 Webhook 的区别:
//   Webhook :腾讯主动 POST 到你的公网地址,需要域名 + 回调配置
//   WebSocket:机器人主动连 api.bot.qq.com,不需要公网地址,但要维持长连接
//
// 在 Cloudflare Workers 上维持长连接的唯一办法是把它放进 Durable Object:
// DO 只要还有活跃的 WebSocket 就不会休眠,连接得以保持。
//
// 代价(必须知道):DO 持续运行会消耗时长额度。免费套餐是 13,000 GB-s/天,
// DO 按 128MB 计费,24 小时 = 86400 × 0.125 = 10,800 GB-s,约占 83%。
// 所以 GATEWAY_MODE 默认可以用 webhook 关掉长连接。

const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
};

export { OP };

// Intents:GUILDS + GROUP_AND_C2C_EVENT(群聊/单聊,含 @消息、加群、加好友)+ 公域频道消息
export const INTENT_GUILDS = 1 << 0;
export const INTENT_GROUP_AND_C2C = 1 << 25;
export const INTENT_PUBLIC_GUILD_MESSAGES = 1 << 30;
export const DEFAULT_INTENTS = INTENT_GUILDS | INTENT_GROUP_AND_C2C | INTENT_PUBLIC_GUILD_MESSAGES;

const UA = 'QQBot-NB-API/1.0 (+cloudflare-workers)';
const WATCHDOG_MS = 60_000;

/**
 * 真正建立 WebSocket 连接。抽出来是为了让测试能塞一个假的进来
 * (Node 的 fetch 不支持 Upgrade: websocket)。
 */
export async function defaultConnect(url) {
  const resp = await fetch(url, { headers: { Upgrade: 'websocket', 'User-Agent': UA } });
  const ws = resp.webSocket;
  if (!ws) throw new Error(`网关没有接受 WebSocket 握手(HTTP ${resp.status})`);
  ws.accept();
  return ws;
}

/** 把 WS 的 onmessage 包装成统一接口,方便测试注入 */
function onMessage(ws, handler) {
  if (typeof ws.addEventListener === 'function') {
    ws.addEventListener('message', (e) => handler(e.data));
  } else {
    ws.onmessage = (e) => handler(e.data);
  }
}

function onClose(ws, handler) {
  if (typeof ws.addEventListener === 'function') {
    ws.addEventListener('close', (e) => handler(e));
    ws.addEventListener('error', () => handler({ error: true }));
  } else {
    ws.onclose = handler;
    ws.onerror = () => handler({ error: true });
  }
}

export class GatewayClient {
  constructor({ cfg, log, getToken, onEvent, onWake, kv, connectFn }) {
    this.cfg = cfg;
    this.log = log || (() => {});
    this.getToken = getToken;
    this.onEvent = onEvent;
    this.onWake = onWake;          // (delayMs) => void,用来安排闹钟
    this.kv = kv || { get: () => null, set: () => {} };
    this.connectFn = connectFn || defaultConnect;

    this.enabled = cfg.gatewayMode === 'websocket';
    this.ws = null;
    this.connected = false;
    this.ready = false;
    this.sessionId = null;
    this.seq = null;
    this.heartbeatInterval = 45_000;
    this.lastAckAt = 0;
    this.connectedAt = 0;
    this.lastEventAt = 0;
    this.lastError = null;
    this.attempts = 0;
    this.connecting = false;
    this.hbTimer = null;
    this.eventCount = 0;

    // 上次的会话状态持久化,断线后可以 Resume 补发漏掉的事件
    const savedSession = this.kv.get('gw_session');
    const savedSeq = this.kv.get('gw_seq');
    if (savedSession) this.sessionId = savedSession;
    if (savedSeq) this.seq = Number(savedSeq) || null;
  }

  /** 闹钟该在什么时候醒过来 */
  nextWakeAt(now) {
    if (!this.enabled) return null;
    if (this.connected) return now + WATCHDOG_MS;
    return now + this._backoffMs();
  }

  _backoffMs() {
    const base = Math.min(60_000, 1000 * 2 ** Math.min(this.attempts, 6));
    return base + Math.floor(Math.random() * 500);
  }

  status() {
    return {
      enabled: this.enabled,
      connected: this.connected,
      ready: this.ready,
      sessionId: this.sessionId ? `${String(this.sessionId).slice(0, 8)}…` : null,
      seq: this.seq,
      heartbeatInterval: this.heartbeatInterval,
      lastAckAgoMs: this.lastAckAt ? Date.now() - this.lastAckAt : null,
      connectedForMs: this.connectedAt ? Date.now() - this.connectedAt : null,
      lastEventAgoMs: this.lastEventAt ? Date.now() - this.lastEventAt : null,
      events: this.eventCount,
      attempts: this.attempts,
      lastError: this.lastError,
    };
  }

  /** 建立连接(已连则跳过)。由闹钟/请求驱动。 */
  async ensure() {
    if (!this.enabled) return false;
    if (this.connected && this.ws) return true;
    if (this.connecting) return false;
    this.connecting = true;
    try {
      await this._connect();
      return true;
    } catch (e) {
      this.attempts++;
      this.lastError = String(e?.message || e);
      this.log(`连接失败(第 ${this.attempts} 次): ${this.lastError}`);
      this._wake(this._backoffMs());
      return false;
    } finally {
      this.connecting = false;
    }
  }

  async _connect() {
    const { cfg } = this;
    const info = await fetch(`${cfg.apiBase}/gateway`, {
      headers: { 'Authorization': `QQBot ${await this.getToken()}`, 'User-Agent': UA },
    });
    if (!info.ok) throw new Error(`取网关地址失败 HTTP ${info.status}`);
    const { url } = await info.json();
    if (!url) throw new Error('网关地址为空');

    const ws = await this.connectFn(url);
    this.ws = ws;
    this.connected = true;
    this.ready = false;
    this.connectedAt = Date.now();
    this.lastAckAt = Date.now();
    this.log(`已连上网关 ${url}`);

    onMessage(ws, (data) => {
      this._handle(String(data)).catch((e) => this.log(`处理网关消息出错: ${e?.message || e}`));
    });
    onClose(ws, () => {
      if (this._closedByUs) {
        this._closedByUs = false;
        return;
      }
      this.log('连接断开,准备重连');
      this._teardown();
      this.attempts++;
      this._wake(this._backoffMs());
    });
    return true;
  }

  _teardown() {
    this.connected = false;
    this.ready = false;
    this.ws = null;
    if (this.hbTimer) {
      clearInterval(this.hbTimer);
      this.hbTimer = null;
    }
  }

  close() {
    this._closedByUs = true;
    this._teardown();
    try {
      this.ws?.close?.();
    } catch { /* ignore */ }
  }

  _wake(ms) {
    try {
      this.onWake?.(ms);
    } catch { /* ignore */ }
  }

  _send(op, d) {
    if (!this.ws || !this.connected) return false;
    try {
      this.ws.send(JSON.stringify({ op, d }));
      return true;
    } catch (e) {
      this.lastError = String(e?.message || e);
      return false;
    }
  }

  async _handle(raw) {
    let p;
    try {
      p = JSON.parse(raw);
    } catch {
      return;
    }
    switch (p.op) {
      case OP.HELLO: {
        this.heartbeatInterval = Number(p.d?.heartbeat_interval) || 45_000;
        this.log(`收到 Hello,心跳间隔 ${this.heartbeatInterval}ms`);
        await this._authenticate();
        this._startHeartbeat();
        break;
      }
      case OP.HEARTBEAT_ACK: {
        this.lastAckAt = Date.now();
        break;
      }
      case OP.RECONNECT: {
        this.log('网关要求重连');
        this.close();
        this._wake(1000);
        break;
      }
      case OP.INVALID_SESSION: {
        this.log('会话失效,清掉 session 重新 Identify');
        this.sessionId = null;
        this.seq = null;
        this.kv.set('gw_session', '');
        this.kv.set('gw_seq', '');
        this.close();
        this._wake(3000);
        break;
      }
      case OP.DISPATCH: {
        if (typeof p.s === 'number') {
          this.seq = p.s;
          this.kv.set('gw_seq', String(p.s));
        }
        const t = String(p.t || '');
        if (t === 'READY') {
          this.sessionId = p.d?.session_id || null;
          this.kv.set('gw_session', this.sessionId || '');
          this.ready = true;
          this.attempts = 0;
          this.log(`鉴权成功 session=${String(this.sessionId).slice(0, 8)}…`);
          return;
        }
        if (t === 'RESUMED') {
          this.ready = true;
          this.attempts = 0;
          this.log('会话已恢复');
          return;
        }
        this.eventCount++;
        this.lastEventAt = Date.now();
        try {
          this.onEvent?.(p);
        } catch (e) {
          this.log(`事件入队失败: ${e?.message || e}`);
        }
        break;
      }
      default:
        break;
    }
  }

  async _authenticate() {
    const token = `QQBot ${await this.getToken()}`;
    if (this.sessionId && this.seq) {
      this.log(`尝试 Resume(seq=${this.seq})`);
      this._send(OP.RESUME, { token, session_id: this.sessionId, seq: this.seq });
      return;
    }
    this.log(`发送 Identify(intents=${this.cfg.gatewayIntents})`);
    this._send(OP.IDENTIFY, {
      token,
      intents: this.cfg.gatewayIntents,
      shard: [0, 1],
      properties: { $os: 'linux', $browser: 'qqbot-nb-api', $device: 'cloudflare-workers' },
    });
  }

  _startHeartbeat() {
    if (this.hbTimer) clearInterval(this.hbTimer);
    this.hbTimer = setInterval(() => this.heartbeat(), this.heartbeatInterval);
    // 有些运行时不允许长间隔定时器一直挂着,闹钟兜底
    this._wake(WATCHDOG_MS);
  }

  heartbeat() {
    if (!this.connected) return;
    this._send(OP.HEARTBEAT, this.seq ?? null);
  }

  /** 由闹钟定期调用:看门狗 + 断线重连 */
  async tick() {
    if (!this.enabled) return;
    if (!this.connected) {
      await this.ensure();
      return;
    }
    const silent = Date.now() - this.lastAckAt;
    if (silent > this.heartbeatInterval * 2.5) {
      this.log(`心跳 ${Math.round(silent / 1000)}s 没有 ACK,强制重连`);
      this.lastError = '心跳超时';
      this.close();
      this.attempts++;
      await this.ensure();
      return;
    }
    // 连接健康,顺手补一次心跳
    this.heartbeat();
    this._wake(WATCHDOG_MS);
  }
}
