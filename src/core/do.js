import { loadCfg } from '../store/settings.js';
import { SCHEMA } from './schema.js';
import { logWrite } from '../store/logs.js';
import { bump, bumpDaily, touchGroup } from '../store/stats.js';
import * as P from '../store/projects.js';
import { getFile, mimeFor } from '../store/kvfile.js';
import { chunkText, stripMention, toPlainText, truncate } from '../util/text.js';
import { enhanceFiles } from '../util/seo.js';
import { fetchAccessToken, deliver } from '../qq/api.js';
import { runAgent } from '../agent/loop.js';
import { buildCompressPrompt, buildHelpText } from '../agent/prompt.js';
import { chatWithFallback } from '../agent/llm.js';
import { wsStart, wsClose, wsEnsure, wsStatus } from '../qq/gateway.js';
import { isReservedPath, genSiteId } from '../util/id.js';

const JOB_MAX_PER_ALARM = 25;
const ALARM_DEADLINE_MS = 12 * 60 * 1000;
const EVENT_TTL_MS = 10 * 60 * 1000;
const SANDBOX_MAX_FILE = 200000;
const SANDBOX_MAX_TOTAL = 2 * 1024 * 1024;

export class BotCore {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this._cfg = null;
    this._cfgAt = 0;
    for (const stmt of SCHEMA) this.sql.exec(stmt);
  }

  async cfg(force = false) {
    if (!force && this._cfg && Date.now() - this._cfgAt < 5000) return this._cfg;
    this._cfg = await loadCfg(this.env);
    this._cfgAt = Date.now();
    return this._cfg;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const p = url.pathname;
    let body = null;
    if (request.method === 'POST') {
      try {
        body = await request.json();
      } catch {
        body = null;
      }
    }
    try {
      switch (p) {
        case '/enqueue':
          return json(this.enqueue(body || {}));
        case '/tick':
          return json(await this.tick());
        case '/status':
          return json(await this.status());
        case '/apply':
          return json(await this.apply());
        case '/ws':
          return json(await wsEnsure(this));
        case '/ws/start':
          return json(await wsStart(this, { force: true }));
        case '/ws/stop':
          wsClose(this);
          return json({ ok: true });
        case '/site/list':
          return json({ sites: await this.listSites() });
        case '/site/get':
          return json(await this.getSite(String(body?.id || '')));
        case '/site/delete':
          return json(await this.deleteSite(String(body?.id || '')));
        case '/sandbox/list':
          return json({ files: this.sandboxList(String(body?.path || '')) });
        case '/sandbox/read':
          return json(this.sandboxRead(String(body?.path || '')));
        default:
          return json({ error: 'not found', path: p }, 404);
      }
    } catch (e) {
      await logWrite(this.env, 'error', 'do', `DO 接口出错 ${p}: ${e?.stack || e}`);
      return json({ error: String(e?.message || e) }, 500);
    }
  }

  armAlarm(ms = 1000) {
    const at = Date.now() + ms;
    this.ctx.storage.setAlarm(at);
    return at;
  }

  scheduleReconnect(ms) {
    this.armAlarm(Math.max(1000, ms));
  }

  async alarm() {
    try {
      await this.tick();
    } catch (e) {
      await logWrite(this.env, 'error', 'do', `闹钟出错:${e?.stack || e}`);
    }
  }

  async tick() {
    const cfg = await this.cfg(true);
    let note = '';
    if (cfg.mode === 'websocket') {
      const r = await wsEnsure(this);
      note = r?.note || '';
    } else if (this.ws) {
      wsClose(this);
      note = '已切换为 WebHook 模式,WebSocket 已关闭';
    }

    const expired = await P.purgeExpired(this.env).catch(() => []);
    if (expired.length) await logWrite(this.env, 'info', 'do', `自动清理过期项目:${expired.join(', ')}`);

    let processed = 0;
    const deadline = Date.now() + ALARM_DEADLINE_MS;
    // 多并发:一次领一批任务并行跑,单条消息的长时间非流式请求不再堵住后面排队的人
    const concurrency = Math.max(1, Math.min(10, Number(cfg.agentConcurrency) || 4));
    while (processed < JOB_MAX_PER_ALARM && Date.now() < deadline) {
      const batch = [];
      while (batch.length < concurrency) {
        const job = this.claimNextJob();
        if (!job) break;
        batch.push(job);
      }
      if (!batch.length) break;
      processed += batch.length;
      await Promise.allSettled(batch.map(async (job) => {
        try {
          await this.runJob(job);
          this.finishJob(job.id, null);
        } catch (e) {
          this.finishJob(job.id, String(e?.stack || e).slice(0, 800));
          await logWrite(this.env, 'error', 'do', `任务失败 ${job.kind}:${e?.message || e}`);
          try {
            await this.notifyFailure(job.payload, e);
          } catch {
            /* ignore */
          }
        }
      }));
    }

    const pending = this.countJobs('pending');
    if (pending > 0) this.armAlarm(500);
    else if (cfg.mode === 'websocket' && (!this.ws || this.wsState !== 'open')) this.armAlarm(60000);
    return { ok: true, processed, pending, ws: wsStatus(this), note };
  }

  async apply() {
    const cfg = await this.cfg(true);
    if (cfg.mode === 'websocket') {
      const r = await wsStart(this, { force: true });
      return { ok: r.ok, note: r.ok ? '已切换到 WebSocket 模式并连接' : `WebSocket 连接失败:${r.note}`, ws: wsStatus(this) };
    }
    const hadWs = !!this.ws;
    wsClose(this);
    // 已经是 WebHook 模式时不要每次保存设置都弹「已切换到 WebHook 模式」——
    // 面板里改一个无关开关也会走 apply,那个提示会让人以为配置被改了。
    return { ok: true, note: hadWs ? '已切换到 WebHook 模式' : '', ws: wsStatus(this) };
  }

  enqueue(payload) {
    const id = payload.eventId || `j_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const seen = this.sql.exec('SELECT id FROM jobs WHERE id = ?', id).toArray();
    if (seen.length) return { ok: true, duplicate: true };
    this.sql.exec(
      'INSERT INTO jobs (id, kind, payload, status, created_at) VALUES (?, ?, ?, ?, ?)',
      id, payload.kind || 'message', JSON.stringify(payload), 'pending', Date.now());
    this.armAlarm(300);
    return { ok: true, id };
  }

  claimNextJob() {
    const rows = this.sql
      .exec("SELECT * FROM jobs WHERE status = 'pending' ORDER BY created_at LIMIT 1").toArray();
    if (!rows.length) return null;
    const row = rows[0];
    this.sql.exec("UPDATE jobs SET status = 'running', started_at = ? WHERE id = ?", Date.now(), row.id);
    let payload = {};
    try {
      payload = JSON.parse(row.payload);
    } catch {
      payload = {};
    }
    return { id: row.id, kind: row.kind, payload };
  }

  finishJob(id, error) {
    this.sql.exec('UPDATE jobs SET status = ?, error = ? WHERE id = ?', error ? 'failed' : 'done', error || null, id);
    this.sql.exec("DELETE FROM jobs WHERE status IN ('done','failed') AND created_at < ?", Date.now() - EVENT_TTL_MS);
  }

  countJobs(status) {
    const r = this.sql.exec('SELECT COUNT(*) AS n FROM jobs WHERE status = ?', status).toArray();
    return r.length ? Number(r[0].n) : 0;
  }

  async runJob(job) {
    if (job.kind === 'message') return await this.handleMessage(job.payload);
    return null;
  }

  async onJoin(task) {
    const cfg = await this.cfg();
    if (task.type === 'GROUP_ADD_ROBOT' && task.targetId) {
      await logWrite(this.env, 'info', 'qq', `机器人被拉进群 ${task.targetId}`);
      const settings = cfg.settings;
      if (settings.groups.allowAll) {
        const list = settings.groups.list || [];
        if (!list.some((g) => g.openid === task.targetId)) {
          list.unshift({ openid: task.targetId, addedAt: Date.now() });
          const { savePatch } = await import('../store/settings.js');
          await savePatch(this.env, { groups: { list } });
        }
      }
    }
  }
}

Object.assign(BotCore.prototype, {
  async handleMessage(p) {
    const cfg = await this.cfg();
    const convId = p.convId;
    const rawText = String(p.text || '').trim();
    const text = stripMention(rawText);
    // QQ 的 GROUP_MESSAGE_CREATE(全量接收)即使 @了机器人,mentioned 也可能是 false。
    // 只要原文里出现了 <@...>,就按"被 @"处理,否则 /帮助、@我 说话都会被静默丢掉。
    const hadMention = rawText !== text;
    const mentioned = p.mentioned !== false || hadMention;
    const log = (m, lv = 'info') => logWrite(this.env, lv, 'chat', m);

    log(`[收到] ${p.scene} ${p.nickname || p.userId || ''} type=${p.type || '?'} mentioned=${mentioned} :: ${truncate(text, 120)}`);

    // 群消息缓存(group_recent / group_find 用):全量接收模式下,没 @机器人 的消息也存下来
    if (p.scene === 'group' && p.targetId && p.mentioned !== undefined && cfg.groupsCacheEnabled) {
      try {
        this.cacheGroupMessage(cfg, { ...p, text });
      } catch {
        /* 缓存失败不影响对话 */
      }
    }

    // 群内全量消息(没 @机器人,即 QQ 后台开了「机器人可查询群内所有消息」之后推来的每一条)
    // 只有 /AI 开头的才触发 Agent,其余静默忽略 —— 否则整个群聊都会被拿去跑 AI。
    if (p.scene === 'group' && !mentioned && parseAiPrefix(text) === null) {
      return;
    }

    if (p.scene === 'group' && p.targetId) {
      const settings = cfg.settings;
      const list = settings.groups.list || [];
      const known = list.some((g) => g.openid === p.targetId);
      if (!settings.groups.allowAll && !known) {
        log(`[忽略] 群 ${p.targetId} 不在白名单里`);
        return;
      }
      if (settings.groups.allowAll && !known) {
        const { savePatch } = await import('../store/settings.js');
        list.unshift({ openid: p.targetId, addedAt: Date.now() });
        await savePatch(this.env, { groups: { list } }).catch(() => null);
      }
      await touchGroup(this.env, p.targetId, '').catch(() => null);
    }

    await bump(this.env, 'messages', 1).catch(() => null);
    await bumpDaily(this.env, 'messages', 1).catch(() => null);

    const cmd = parseCommand(text);

    if (cmd.name === 'info') {
      const lines = [
        '🪪 你的信息',
        `· 你的 openID:${p.userId || '(未知)'}`,
        p.scene === 'group' ? `· 群聊 openID:${p.targetId}` : '· 当前是单聊',
        `· 会话 ID:${convId}`,
        `· 身份:${this.isAdmin(cfg, p) ? '管理员' : '普通成员'}`,
        '',
        '把 openID 复制到管理面板的「设置 → 群聊权限 / 管理员」里就能授权。',
      ];
      await this.reply(p, lines.join('\n'));
      return;
    }

    if (cmd.name === 'help' || (!text && !cmd.name)) {
      await this.reply(p, buildHelpText(cfg));
      return;
    }
    if (cmd.name === 'delete' || cmd.name === 'clear' || cmd.name === 'reset') {
      this.clearContext(convId);
      await this.reply(p, '🧹 已清空这个会话的全部上下文,我们重新开始。');
      return;
    }
    if (cmd.name === 'compress') {
      const r = await this.compressContext(convId);
      await this.reply(p, r.ok
        ? `🗜 已压缩上下文。摘要 ${r.summary.length} 字,保留最近 ${r.kept} 条消息。`
        : `压缩失败:${r.error}`);
      return;
    }
    if (cmd.name === 'memory') {
      const list = this.memList(convId);
      await this.reply(p, list.length
        ? ['🧠 我记住的这些事:', ...list.map((m, i) => `${i + 1}. ${m.key} → ${m.value}`)].join('\n')
        : '🧠 这个会话还没有记住任何事。对我说「记住 xxx」我就会记下来。');
      return;
    }
    if (cmd.name === 'status') {
      const s = await this.status();
      const c = this.getContext(convId);
      await this.reply(p, [
        '📊 当前状态',
        `· 在线部署:${s.sites}/${s.maxSites}`,
        `· 排队任务:${s.pending} 待处理 / ${s.running} 执行中`,
        `· 连接方式:${s.mode === 'webhook' ? 'WebHook' : 'WebSocket'}${s.ws?.connected ? '(已连接)' : ''}`,
        `· 本会话:摘要 ${c.summary ? `${c.summary.length} 字` : '无'},历史 ${c.messages.length} 条,记忆 ${this.memList(convId).length} 条`,
        `· 模型:${cfg.llmModel}(思考 ${cfg.reasoningEffort})`,
        `· 部署存活:${Math.round(cfg.siteTtlSeconds / 60)} 分钟`,
      ].join('\n'));
      return;
    }

    let body = cmd.name === 'ai' ? cmd.args : text;
    if (cmd.name !== 'ai') {
      // '/AI你好' 这种没空格的写法 parseCommand 认不出来,这里手动剥掉前缀
      const stripped = parseAiPrefix(text);
      if (stripped !== null) body = stripped;
    }
    if (!body) {
      await this.reply(p, buildHelpText(cfg));
      return;
    }

    // AI 接口没配好时,直接给一句人话,别让用户等到一个 fetch 报错
    if (!cfg.llmBaseUrl || !cfg.llmApiKey) {
      const lack = [!cfg.llmBaseUrl ? '接口地址' : '', !cfg.llmApiKey ? 'API Key' : '']
        .filter(Boolean).join('、');
      await logWrite(this.env, 'warn', 'agent', `AI 接口未配置(${lack}),已拒绝请求`).catch(() => null);
      await this.reply(p, `⚙️ 管理员还没有配置 AI 接口(缺 ${lack})。\n`
        + '请到管理面板「设置 → AI 接口」填写地址、Key 和模型,保存后再来找我。');
      return;
    }

    const receivedAt = Number(p.ts) || Date.now();
    // QQ 被动回复窗口:群聊 5 分钟、单聊 60 分钟,这里各留一点余量
    const passiveWindowMs = p.scene === 'c2c' ? 55 * 60 * 1000 : 4.5 * 60 * 1000;
    const overWindow = () => Date.now() - receivedAt > passiveWindowMs;

    // 回执只在被动窗口内发;已经超窗就省下宝贵的主动额度,等结果一次性投递
    if (!overWindow()) {
      await this.reply(p, '🤖 Agent 正在运行,请稍等…', { mode: 'passive' });
    }
    const started = Date.now();

    const result = await runAgent({
      cfg,
      core: this,
      convId,
      userText: body,
      meta: { botName: 'NOMO', nickname: p.nickname },
      log,
    });

    const plain = toPlainText(result.reply);
    // 投递策略:auto = 被动窗口内用被动回复,超窗自动改用主动消息;active = 始终主动
    const answerMode = cfg.answerDelivery === 'active' ? 'active' : (overWindow() ? 'active' : 'passive');
    const delivered = await this.reply(p, plain, { mode: answerMode });
    log(`[投递] 方式=${delivered.mode} 条数=${delivered.sent.length}`);

    this.appendMessages(convId, [
      { role: 'user', content: truncate(body, 1500) },
      { role: 'assistant', content: truncate(plain, 2500) },
    ]);
    this.trimContext(convId);
    try {
      await this.maybeAutoCompress(convId);
    } catch (e) {
      log(`[上下文] 自动压缩失败 ${e?.message || e}`, 'warn');
    }

    await bump(this.env, 'replies', 1).catch(() => null);
    await bump(this.env, 'tokens', result.usageTotal || 0).catch(() => null);
    await bump(this.env, 'tools', result.toolTrace.length || 0).catch(() => null);
    log(`[完成] 轮次=${result.rounds} 工具=${result.toolTrace.length} token=${result.usageTotal} 耗时=${Date.now() - started}ms 降级=${result.downgraded}`);
  },

  isAdmin(cfg, p) {
    const admins = cfg.settings.admin.openIds || [];
    if (admins.some((a) => a.openid === p.userId)) return true;
    return false;
  },

  async notifyFailure(p, e) {
    try {
      await this.reply(p, `😵 处理这条消息时出错了:${truncate(String(e?.message || e), 150)}\n稍后再试一次吧。`);
      await bump(this.env, 'errors', 1).catch(() => null);
    } catch {
      /* ignore */
    }
  },

  async getToken(force = false) {
    const now = Date.now();
    if (!force) {
      const rows = this.sql.exec("SELECT v, exp FROM kv WHERE k = 'qq_token'").toArray();
      if (rows.length && Number(rows[0].exp) > now + 60000) return rows[0].v;
    }
    const cfg = await this.cfg();
    const r = await fetchAccessToken(cfg);
    this.sql.exec('INSERT INTO kv (k, v, exp) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, exp = excluded.exp',
      'qq_token', r.token, r.expiresAt);
    return r.token;
  },

  async reply(p, text, opts = {}) {
    const first = await this.deliverOnce(p, text, opts.mode);
    if (first.sent.length) return first;
    const other = opts.mode === 'active' ? 'passive' : 'active';
    await logWrite(this.env, 'warn', 'send', `${opts.mode || 'passive'} 一条都没发出去,改用 ${other} 重试`);
    const second = await this.deliverOnce(p, text, other);
    await bump(this.env, `delivery_fallback_${other}`, 1).catch(() => null);
    return second;
  },

  async deliverOnce(p, text, mode = 'passive') {
    const cfg = await this.cfg();
    const token = await this.getToken();
    // 条数上限:QQ 同一条消息最多回复 4~5 次(单聊 4 / 群聊 5),回执已经用掉 1 次,这里留够余量
    const maxChunks = p.scene === 'c2c' ? 3 : 4;
    const chunks = chunkText(text, cfg.chunkChars || 1500, maxChunks);
    if (!chunks.length) return { sent: [], errors: [], mode };
    const target = p.scene === 'c2c' ? { kind: 'c2c', id: p.targetId } : { kind: 'group', id: p.targetId };
    const r = await deliver(cfg, token, target, {
      chunks,
      mode,
      msgId: p.messageId,
      msgSeqStart: this.nextSeq(p),
    });
    if (r.errors.length) await logWrite(this.env, 'warn', 'send', `发送错误:${r.errors.join(' | ')}`);
    await bump(this.env, mode === 'active' ? 'messages_active' : 'messages_passive', r.sent.length).catch(() => null);
    await bump(this.env, 'messages', 0).catch(() => null);
    return r;
  },

  nextSeq(p) {
    const key = `seq_${p.convId}`;
    const rows = this.sql.exec('SELECT v FROM kv WHERE k = ?', key).toArray();
    const n = (rows.length ? parseInt(rows[0].v, 10) || 0 : 0) + 1;
    this.sql.exec('INSERT INTO kv (k, v, exp) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, exp = excluded.exp',
      key, String(n), Date.now() + 6 * 60 * 1000);
    return n;
  },

  getContext(convId) {
    const c = this.sql.exec('SELECT * FROM conv WHERE id = ?', convId).toArray();
    const msgs = this.sql.exec('SELECT role, content FROM msg WHERE conv_id = ? ORDER BY seq', convId).toArray();
    return { summary: c.length ? c[0].summary : '', messages: msgs.map((m) => ({ role: m.role, content: m.content })) };
  },

  appendMessages(convId, list) {
    const r = this.sql.exec('SELECT COALESCE(MAX(seq), 0) AS s FROM msg WHERE conv_id = ?', convId).toArray();
    let seq = r.length ? Number(r[0].s) : 0;
    for (const m of list) {
      seq++;
      this.sql.exec('INSERT INTO msg (conv_id, seq, role, content, ts) VALUES (?, ?, ?, ?, ?)',
        convId, seq, m.role, m.content, Date.now());
    }
    this.sql.exec('INSERT INTO conv (id, summary, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at',
      convId, '', Date.now());
  },

  trimContext(convId) {
    const cfgKeep = 12;
    const rows = this.sql.exec('SELECT seq FROM msg WHERE conv_id = ? ORDER BY seq DESC LIMIT 1', convId).toArray();
    if (!rows.length) return;
    const max = Number(rows[0].seq);
    const cut = max - cfgKeep;
    if (cut > 0) this.sql.exec('DELETE FROM msg WHERE conv_id = ? AND seq <= ?', convId, cut);
  },

  clearContext(convId) {
    this.sql.exec('DELETE FROM msg WHERE conv_id = ?', convId);
    this.sql.exec('DELETE FROM conv WHERE id = ?', convId);
    this.sql.exec('DELETE FROM mem WHERE conv_id = ?', convId);
  },

  setSummary(convId, summary) {
    this.sql.exec('INSERT INTO conv (id, summary, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET summary = excluded.summary, updated_at = excluded.updated_at',
      convId, summary, Date.now());
  },

  async compressContext(convId) {
    const cfg = await this.cfg();
    const c = this.getContext(convId);
    if (c.messages.length < 4) return { ok: false, error: '消息太少,不需要压缩' };
    const text = c.messages.map((m) => `${m.role === 'user' ? '用户' : '助手'}:${truncate(m.content, 400)}`).join('\n');
    const r = await chatWithFallback(cfg, [
      { role: 'system', content: buildCompressPrompt() },
      { role: 'user', content: text.slice(-8000) },
    ], null, { timeoutMs: 60000 });
    if (!r.content.trim()) return { ok: false, error: r.error || '模型没有返回摘要' };
    this.setSummary(convId, r.content.trim().slice(0, 2000));
    this.sql.exec('DELETE FROM msg WHERE conv_id = ?', convId);
    return { ok: true, summary: r.content.trim(), kept: 0 };
  },

  async maybeAutoCompress(convId) {
    const cfg = await this.cfg();
    const c = this.getContext(convId);
    const total = c.messages.reduce((s, m) => s + m.content.length, 0);
    if (total < cfg.compressChars) return;
    await this.compressContext(convId);
  },
});

Object.assign(BotCore.prototype, {
  async listSites() {
    const cfg = await this.cfg();
    const rows = await P.listProjects(this.env);
    await logWrite(this.env, 'info', 'site', `list_sites 查询:在线 ${rows.length} 个`).catch(() => null);
    const out = [];
    for (const r of rows) {
      const files = await P.listFiles(this.env, r.id);
      out.push({
        id: r.id,
        name: r.name,
        description: r.description,
        url: this.siteUrl(cfg, r.id),
        expiresAt: Number(r.expires_at),
        leftSeconds: Math.max(0, Math.round((Number(r.expires_at) - Date.now()) / 1000)),
        hits: Number(r.hits || 0),
        files: files.map((f) => f.path),
      });
    }
    return out;
  },

  // 最近到期销毁的项目名,给 list_sites 做"为什么没有"的解释用。
  // 项目过期后很快会被自动清理,所以除了还没清理的,还要翻清理日志。
  async recentExpired(hours = 2) {
    const cut = Date.now() - hours * 3600 * 1000;
    const now = Date.now();
    const names = new Set();
    const rows = await P.listProjects(this.env, { includeExpired: true }).catch(() => []);
    for (const r of rows) {
      if (Number(r.expires_at) <= now && Number(r.expires_at) > cut) names.add(r.name || r.id);
    }
    const r2 = await this.env.DB.prepare(
      "SELECT msg FROM logs WHERE tag = 'do' AND msg LIKE '自动清理过期项目%' AND ts > ? ORDER BY id DESC LIMIT 10",
    ).bind(cut).all().catch(() => ({ results: [] }));
    for (const row of r2.results || []) {
      for (const name of String(row.msg).replace(/^自动清理过期项目[:：]?/, '').split(/[,，、]/)) {
        const t = name.trim();
        if (t) names.add(t);
      }
    }
    return [...names].slice(0, 5);
  },

  async getSite(id) {
    const cfg = await this.cfg();
    const p = await P.getProject(this.env, id);
    if (!p) {
      const byName = await P.findByName(this.env, id);
      if (!byName) return { error: `没有找到 ID 或名称为「${id}」的项目` };
      return await this.getSite(byName.id);
    }
    const files = await P.listFiles(this.env, p.id);
    const out = [];
    for (const f of files) {
      const bytes = await getFile(this.env, p.id, f.path, f.gz);
      const text = bytes && /^text\/|json|javascript|xml|svg/.test(f.ct || '') ? new TextDecoder().decode(bytes) : '';
      out.push({ path: f.path, size: Number(f.size), ct: f.ct, content: text.slice(0, 20000) });
    }
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      url: this.siteUrl(cfg, p.id),
      expiresAt: Number(p.expires_at),
      leftSeconds: Math.max(0, Math.round((Number(p.expires_at) - Date.now()) / 1000)),
      files: out,
    };
  },

  async createSite({ name, description, files, owner }) {
    const cfg = await this.cfg();
    const settings = cfg.settings;
    const id = genId(cfg.idCharset, cfg.idLen);
    const url = this.siteUrl(cfg, id);
    // AI 没写全 SEO 字段时用默认值补齐(写了的不覆盖)
    const enhanced = enhanceFiles(files || [], {
      name: String(name || ''),
      description: String(description || ''),
      url,
    });
    const r = await P.createProject(this.env, settings, {
      id,
      name: String(name || '未命名项目').slice(0, 60),
      description: String(description || '').slice(0, 200),
      owner: String(owner || ''),
      source: 'ai',
      files: enhanced.map((f) => ({ path: f.path, content: f.content, ct: mimeFor(f.path) })),
      ttlSeconds: cfg.siteTtlSeconds,
    });
    if (r.error) return { error: r.error };
    await logWrite(this.env, 'info', 'site', `AI 部署项目 ${id}(${name || ''})`);
    return { id, url: this.siteUrl(cfg, id), ttlMinutes: Math.round(cfg.siteTtlSeconds / 60), name };
  },

  async updateSite(id, { name, files }) {
    const cfg = await this.cfg();
    const p = await P.getProject(this.env, id);
    if (!p) return { error: `没有找到 ID 为 ${id} 的项目` };
    const lim = await P.limitsFor(this.env, cfg.settings, id);
    if (files && files.length) {
      const enhanced = enhanceFiles(files, {
        name: String(p.name || ''),
        description: String(p.description || ''),
        url: this.siteUrl(cfg, id),
      });
      const r = await P.writeFiles(this.env, id, enhanced.map((f) => ({ path: f.path, content: f.content, ct: mimeFor(f.path) })), lim.limit);
      if (r.error) return { error: r.error };
    }
    await P.recalc(this.env, id);
    await P.extendProject(this.env, id, cfg.siteTtlSeconds);
    if (name) await this.env.DB.prepare('UPDATE projects SET name = ? WHERE id = ?').bind(String(name).slice(0, 60), id).run();
    return { ok: true, id, url: this.siteUrl(cfg, id), ttlMinutes: Math.round(cfg.siteTtlSeconds / 60) };
  },

  async deleteSite(id) {
    const p = await P.getProject(this.env, id);
    if (!p) {
      const byName = await P.findByName(this.env, id);
      if (!byName) return false;
      const r = await P.removeProject(this.env, byName.id);
      await logWrite(this.env, 'info', 'site', `删除项目 ${byName.id}`);
      return !r.error;
    }
    const r = await P.removeProject(this.env, id);
    await logWrite(this.env, 'info', 'site', `删除项目 ${id}`);
    return !r.error;
  },

  async countSites() {
    const rows = await P.listProjects(this.env);
    return rows.length;
  },

  siteUrl(cfg, id) {
    const base = cfg.publicBaseUrl || '';
    return base ? `${base}/${id}` : `/${id}`;
  },

  async dataGet(siteId, key) {
    return await P.dataGet(this.env, siteId, key);
  },

  async dataPut(siteId, key, value) {
    const cfg = await this.cfg();
    if (!cfg.allowData) return { error: '管理员关闭了项目数据存储' };
    return await P.dataSet(this.env, siteId, key, value, cfg.dataQuotaBytes);
  },

  memSet(convId, key, value) {
    this.sql.exec('INSERT INTO mem (conv_id, k, v, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(conv_id, k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at',
      convId, String(key).slice(0, 60), String(value).slice(0, 1000), Date.now());
    return { ok: true };
  },

  memList(convId) {
    return this.sql.exec('SELECT k, v FROM mem WHERE conv_id = ? ORDER BY updated_at DESC', convId).toArray()
      .map((r) => ({ key: r.k, value: r.v }));
  },

  memDel(convId, key) {
    this.sql.exec('DELETE FROM mem WHERE conv_id = ? AND k = ?', convId, String(key));
    return true;
  },

  memClear(convId) {
    this.sql.exec('DELETE FROM mem WHERE conv_id = ?', convId);
  },

  sandboxList(prefix = '') {
    const p = String(prefix || '');
    const rows = p
      ? this.sql.exec('SELECT path, LENGTH(content) AS size, updated_at FROM fs WHERE path LIKE ? ORDER BY path', `${p}%`).toArray()
      : this.sql.exec('SELECT path, LENGTH(content) AS size, updated_at FROM fs ORDER BY path').toArray();
    return rows.map((r) => ({ path: r.path, size: Number(r.size), updatedAt: Number(r.updated_at) }));
  },

  sandboxRead(path) {
    const rows = this.sql.exec('SELECT content, updated_at FROM fs WHERE path = ?', String(path)).toArray();
    if (!rows.length) return { error: `沙盒里没有文件 ${path}` };
    return { path, content: rows[0].content, updatedAt: Number(rows[0].updated_at) };
  },

  sandboxWrite(path, content) {
    const p = String(path || '').replace(/^\/+/, '');
    if (!p) return { error: '路径不能为空' };
    const body = String(content ?? '');
    if (body.length > SANDBOX_MAX_FILE) return { error: `单个文件不能超过 ${Math.round(SANDBOX_MAX_FILE / 1024)} KB` };
    const cur = this.sql.exec('SELECT COALESCE(SUM(LENGTH(content)), 0) AS s FROM fs').toArray();
    const total = cur.length ? Number(cur[0].s) : 0;
    if (total + body.length > SANDBOX_MAX_TOTAL) return { error: '沙盒空间已满,先删掉一些文件' };
    this.sql.exec('INSERT INTO fs (path, content, updated_at) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at',
      p, body, Date.now());
    return { ok: true, path: p, size: body.length };
  },

  sandboxEdit(path, find, replace) {
    const cur = this.sandboxRead(path);
    if (cur.error) return cur;
    if (!cur.content.includes(find)) return { error: '没有找到要替换的内容' };
    return this.sandboxWrite(path, cur.content.split(find).join(replace));
  },

  sandboxDelete(path) {
    this.sql.exec('DELETE FROM fs WHERE path = ?', String(path));
    return { ok: true };
  },

  // -------------------------------------------------------------------------
  // 群消息缓存:写 + 裁剪 + 查询(group_recent / group_find 两个工具用)
  // -------------------------------------------------------------------------

  cacheGroupMessage(cfg, p) {
    const id = String(p.messageId || '');
    if (!id) return;
    const dup = this.sql.exec('SELECT id FROM gmsg WHERE id = ?', id).toArray();
    if (dup.length) return;
    this.sql.exec(
      'INSERT INTO gmsg (id, group_id, user_id, user_name, content, ts) VALUES (?, ?, ?, ?, ?, ?)',
      id, String(p.targetId), String(p.userId || ''), String(p.nickname || '').slice(0, 60),
      truncate(String(p.text || ''), 2000), Number(p.ts) || Date.now());
    const max = Math.max(20, Math.min(2000, Number(cfg.groupsCachePerGroup) || 300));
    const cnt = this.sql.exec('SELECT COUNT(*) AS n FROM gmsg WHERE group_id = ?', p.targetId).toArray();
    if (cnt.length && Number(cnt[0].n) > max + 50) {
      this.sql.exec(
        'DELETE FROM gmsg WHERE group_id = ? AND id NOT IN (SELECT id FROM gmsg WHERE group_id = ? ORDER BY ts DESC LIMIT ?)',
        p.targetId, p.targetId, max);
    }
    const now = Date.now();
    if (!this._gmsgCleanAt || now - this._gmsgCleanAt > 3600000) {
      this._gmsgCleanAt = now;
      const days = Math.max(1, Math.min(90, Number(cfg.groupsCacheRetentionDays) || 7));
      this.sql.exec('DELETE FROM gmsg WHERE ts < ?', now - days * 86400000);
    }
  },

  async groupRecent(group, limit = 20, convId = '') {
    const n = Math.max(1, Math.min(50, Number(limit) || 20));
    let gid = String(group || '').trim();
    if (!gid && String(convId).startsWith('g:')) gid = String(convId).slice(2);
    if (!gid) return '当前会话不在群里,没法查群消息缓存;请告诉我群名或群 openID。';
    let rows = this.sql.exec('SELECT * FROM gmsg WHERE group_id = ? ORDER BY ts DESC LIMIT ?', gid, n).toArray();
    if (!rows.length) {
      const named = await this.env.DB.prepare(
        'SELECT openid FROM groups WHERE name LIKE ? OR openid LIKE ? ORDER BY last_seen DESC LIMIT 3',
      ).bind(`%${gid}%`, `%${gid}%`).all().catch(() => ({ results: [] }));
      for (const r of named.results || []) {
        rows = this.sql.exec('SELECT * FROM gmsg WHERE group_id = ? ORDER BY ts DESC LIMIT ?', r.openid, n).toArray();
        if (rows.length) break;
      }
    }
    if (!rows.length) {
      return '这个群还没有缓存到消息。需要管理员开启「群消息缓存」,并且在 QQ 后台开启全量消息接收(机器人可查询群内所有消息)。';
    }
    const lines = rows.reverse().map((r) => {
      const t = new Date(Number(r.ts) + 8 * 3600000);
      const p2 = (x) => String(x).padStart(2, '0');
      return `${p2(t.getUTCHours())}:${p2(t.getUTCMinutes())} ${r.user_name || r.user_id || '?'}:${r.content}`;
    });
    return `群消息缓存(最近 ${lines.length} 条,来自机器人收到的消息):\n${lines.join('\n')}`;
  },

  async groupFind(keyword) {
    const kw = String(keyword || '').trim();
    if (!kw) return '请给我一个关键词。';
    const rows = await this.env.DB.prepare(
      'SELECT openid, name, msg_count, last_seen FROM groups WHERE name LIKE ? OR openid LIKE ? ORDER BY last_seen DESC LIMIT 10',
    ).bind(`%${kw}%`, `%${kw}%`).all().catch(() => ({ results: [] }));
    const list = rows.results || [];
    if (!list.length) return `没有找到和「${kw}」相关的群。`;
    const ago = (ts) => {
      const d = Math.max(0, Date.now() - Number(ts || 0));
      if (d < 60000) return `${Math.floor(d / 1000)} 秒前`;
      if (d < 3600000) return `${Math.floor(d / 60000)} 分钟前`;
      if (d < 86400000) return `${Math.floor(d / 3600000)} 小时前`;
      return `${Math.floor(d / 86400000)} 天前`;
    };
    return ['找到这些群:', ...list.map((g) => `· ${g.name || '(未命名)'} | openID=${g.openid} | 消息 ${Number(g.msg_count || 0)} 条 | 最近活跃 ${ago(g.last_seen)}`)].join('\n');
  },

  async status() {
    const cfg = await this.cfg();
    const sites = await P.listProjects(this.env).catch(() => []);
    return {
      sites: sites.length,
      maxSites: cfg.maxSites,
      pending: this.countJobs('pending'),
      running: this.countJobs('running'),
      mode: cfg.mode,
      ws: wsStatus(this),
      model: cfg.llmModel,
      sandbox: this.sandboxList().length,
      uptime: this.wsSince ? Date.now() - this.wsSince : 0,
    };
  },
});

function parseCommand(text) {
  const t = String(text || '').trim();
  if (!t.startsWith('/')) return { name: '', args: '' };
  const m = t.match(/^\/([^\s]+)\s*([\s\S]*)$/);
  const raw = (m?.[1] || '').toLowerCase();
  const args = (m?.[2] || '').trim();
  const map = {
    ai: 'ai', a: 'ai', ask: 'ai', 问: 'ai',
    帮助: 'help', help: 'help', 菜单: 'help', 指令: 'help', '?': 'help',
    delete: 'delete', clear: 'delete', reset: 'delete', 清空: 'delete', 重置: 'delete',
    压缩: 'compress', compress: 'compress', 总结: 'compress', compact: 'compress',
    记忆: 'memory', memory: 'memory', 记住: 'memory',
    状态: 'status', status: 'status',
    查信息: 'info', info: 'info', whoami: 'info', 我的信息: 'info', 查id: 'info',
  };
  return { name: map[raw] || '', args };
}

/**
 * '/AI 问题'、'/ai问题' 都算 AI 触发;返回剥掉前缀后的正文。
 * 不是 AI 触发返回 null(注意区分:触发但正文为空返回 '')。
 */
function parseAiPrefix(text) {
  const m = String(text || '').match(/^\/ai\b\s*([\s\S]*)$/i);
  return m ? m[1].trim() : null;
}

function genId(charset = 'ascii', len = 8) {
  for (let i = 0; i < 20; i++) {
    const s = genSiteId(len, charset);
    if (!isReservedPath(s)) return s;
  }
  return `p${Date.now().toString(36)}`;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
