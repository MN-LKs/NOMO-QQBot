import { loadCfg } from '../store/settings.js';
import { SCHEMA } from './schema.js';
import { logWrite } from '../store/logs.js';
import { bump, bumpMany, bumpDaily, touchGroup } from '../store/stats.js';
import * as P from '../store/projects.js';
import { getFile, mimeFor } from '../store/kvfile.js';
import { chunkText, sealFenceChunks, stripMention, toPlainText, truncate } from '../util/text.js';
import { enhanceFiles } from '../util/seo.js';
import { fetchAccessToken, deliver, deliverMedia, muteGroupMember, unmuteGroupMember, explainError, sendGroupMarkdown, sendC2CMarkdown } from '../qq/api.js';
import { runAgent } from '../agent/loop.js';
import { buildCompressPrompt, buildHelpText, buildHelpMarkdown, buildMenuText } from '../agent/prompt.js';
import { chatWithFallback } from '../agent/llm.js';
import { parseMotdTarget, queryMotd, formatMotdText, fetchMotdImage } from '../agent/motd.js';
import { imageToDataUrl, attachmentKind, describeAttachments } from '../qq/media.js';
import { wsStart, wsClose, wsEnsure, wsStatus } from '../qq/gateway.js';
import { isReservedPath, genSiteId } from '../util/id.js';
import { isMasked } from '../util/secret.js';

const JOB_MAX_PER_ALARM = 25;
const ALARM_DEADLINE_MS = 12 * 60 * 1000;
const EVENT_TTL_MS = 10 * 60 * 1000;
// running 超过这个时间还没跑完,就认为 DO 被驱逐了,把任务放回队列重跑
const JOB_STALE_MS = 10 * 60 * 1000;
const SANDBOX_MAX_FILE = 200000;
const SANDBOX_MAX_TOTAL = 2 * 1024 * 1024;

export class BotCore {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this._cfg = null;
    this._cfgAt = 0;
    this._token = null;
    this._tokenExp = 0;
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
        case '/reset':
          return json(await this.resetState());
        case '/ws':
          return json(await wsEnsure(this));
        case '/ws/start':
          return json(await wsStart(this, { force: true }));
        case '/ws/stop':
          wsClose(this);
          return json({ ok: true });
        case '/site/list':
          return json({ sites: await this.listSites() });
        case '/pending/get':
          return json(await this.getPending(body?.token));
        case '/pending/resolve':
          return json(await this.resolvePending(body?.token, !!body?.approve));
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
    // 先把上次被驱逐后卡在 running 的任务放回队列,再领新任务
    const reclaimed = this.reclaimStaleJobs();
    if (reclaimed) {
      await logWrite(this.env, 'warn', 'do', `发现 ${reclaimed} 条任务卡在执行中(实例被回收),已放回队列重跑`);
      note = `已恢复 ${reclaimed} 条中断任务`;
    }
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

  async resetState() {
    const tables = ['kv', 'conv', 'msg', 'jobs', 'mem', 'fs', 'gmsg', 'pending'];
    for (const t of tables) {
      try {
        this.sql.exec(`DELETE FROM ${t}`);
      } catch {
        /* 旧版本可能还没有这张表 */
      }
    }
    this._cfg = null;
    this._cfgAt = 0;
    this._token = null;
    this._tokenExp = 0;
    return { ok: true };
  }

  async apply() {
    const cfg = await this.cfg(true);
    // QQ 凭据可能刚被改过:丢掉旧的 access token 和配置缓存,下次发消息重新取
    this._token = null;
    this._tokenExp = 0;
    this.sql.exec("DELETE FROM kv WHERE k = 'qq_token'");
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

  // 上一次跑这条任务时 DO 被驱逐/休眠了(Cloudflare 会在闲置时回收隔离实例),
  // 状态还停在 running,没人再来领。这里按 started_at 判定超时,把僵死任务放回队列。
  // 阈值要明显大于单次请求上限(默认 120s),否则会重复回复同一条消息。
  reclaimStaleJobs(maxAgeMs = JOB_STALE_MS) {
    const cutoff = Date.now() - Math.max(30000, Number(maxAgeMs) || JOB_STALE_MS);
    const stale = this.sql
      .exec('SELECT id FROM jobs WHERE status = ? AND started_at IS NOT NULL AND started_at < ?', 'running', cutoff)
      .toArray();
    for (const r of stale) {
      this.sql.exec("UPDATE jobs SET status = 'pending', started_at = NULL WHERE id = ?", r.id);
    }
    return stale.length;
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
    if (job.kind === 'interaction') return await this.handleInteraction(job.payload);
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
    const incoming = incomingContext(p);
    // 只有 QQ 明确判定「@机器人」或单聊才按被提到处理。
    // 全量接收时内容里出现 <@别人> 不再算 @机器人,否则 @任何人都会触发。
    const mentioned = p.scene === 'c2c' ? true : p.mentioned === true;
    const cmd = parseCommand(text);
    const aiBody = parseAiPrefix(text);
    const log = (m, lv = 'info') => logWrite(this.env, lv, 'chat', m);

    log(`[收到] ${p.scene} ${p.nickname || p.userId || ''} type=${p.type || '?'} mentioned=${mentioned} :: ${truncate(text, 120)}`
      + (incoming.attachments ? ` ${incoming.attachments}` : '') + (incoming.quote ? ' [带引用]' : ''));

    // 群消息缓存(group_recent / group_find 用):全量接收模式下,没 @机器人 的消息也存下来
    if (p.scene === 'group' && p.targetId && p.mentioned !== undefined && cfg.groupsCacheEnabled) {
      try {
        this.cacheGroupMessage(cfg, { ...p, text });
      } catch {
        /* 缓存失败不影响对话 */
      }
    }

    // 全量群消息只有两种触发:AI<空格>正文、/AI<空格>正文,或以 / 开头的命令。
    // 「你看这个AI」「尝试用/帮助」「@别人」都静默忽略。
    if (p.scene === 'group' && !mentioned && aiBody === null && !cmd.name) {
      return;
    }
    // 无参数命令后面多写了内容就不触发,例如「/帮助 好垃圾」。
    if (NO_ARG_COMMANDS.has(cmd.name) && cmd.args) {
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

    if (cmd.name === 'info') {
      const lines = [
        '🪪 你的信息',
        `· 你的 openID:${p.userId || '(未知)'}`,
        p.scene === 'group' ? `· 群聊 openID:${p.targetId}` : '· 当前是单聊',
        `· 会话 ID:${convId}`,
        `· 身份:${this.isAdmin(cfg, p) ? '管理员' : '普通成员'}${p.scene === 'group' ? ` · 群角色:${p.memberRole || 'member'}` : ''}`,
        '',
        '把 openID 复制到管理面板的「设置 → 群聊权限 / 管理员」里就能授权。',
      ];
      await this.reply(p, lines.join('\n'));
      return;
    }

    if (cmd.name === 'help' || cmd.name === 'menu' || (mentioned && !text && !cmd.name && !incoming.attachments)) {
      const isMenu = cmd.name === 'menu' || (!text && !cmd.name);
      const content = isMenu
        ? buildMenuText(cfg, { markdown: cfg.markdownEnabled })
        : (cfg.markdownEnabled ? buildHelpMarkdown(cfg) : buildHelpText(cfg));
      await this.reply(p, content, { markdown: cfg.markdownEnabled });
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
    if (cmd.name === 'motd') {
      await this.handleMotd(p, cmd.args, cfg);
      return;
    }
    if (cmd.name === 'mute' || cmd.name === 'unmute' || cmd.name === 'kick') {
      await this.handleAdminAction(p, cmd.name, cmd.args, cfg);
      return;
    }

    // 触发正文:AI<空格>正文 / /AI<空格>正文;或被 @机器人 后直接说话。
    // 只 @了别人、或普通闲聊不发任何消息。
    let body = aiBody;
    if (!body && mentioned && text && !cmd.name) body = text;
    if (!body && incoming.attachments) body = '请看看我发的内容。';
    if (!body) {
      // 只有 @机器人 但没写正文时才发菜单。
      if (mentioned && !text && !incoming.attachments) {
        await this.reply(p, buildMenuText(cfg, { markdown: cfg.markdownEnabled }), { markdown: cfg.markdownEnabled });
      }
      return;
    }

    // 应急强制更新:管理员一键开启后,机器人停止服务,统一回升级提示。
    // 放在最前面,连 AI 配置检查都要让路 —— 这时候配置对不对都不重要了。
    if (cfg.forceUpdate) {
      const note = cfg.forceNote || '机器人正在升级,请稍后再试。';
      await logWrite(this.env, 'warn', 'agent', `强制更新已开启,拒绝服务:` + note).catch(() => null);
      await this.reply(p, `🚧 ${note}`);
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

    // 存进去的是面板上的打码值(如 sk-z********6pAm)时,上游一定 401。
    // 与其让它跑一轮再报错,不如现在就点明「重新填一次真 Key」。
    if (isMasked(cfg.llmApiKey)) {
      await logWrite(this.env, 'error', 'agent',
        'AI 接口的 API Key 是面板打码值(sk-****),不是真密钥;请在面板重新粘贴完整 Key').catch(() => null);
      await this.reply(p, '⚙️ AI 接口的 API Key 是面板显示的**打码值**(长这样:sk-z********6pAm),不是真正的密钥,'
        + '所以一直连不上上游。\n请管理员打开管理面板 →「Agent 配置 → 大模型接口」,'
        + '把完整密钥重新粘贴进 API Key 输入框并保存(留空则不会修改),然后就能用了。');
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
    let chatHistory = incoming.history;
    if (p.scene === 'group' && p.targetId && cfg.groupsCacheEnabled) {
      try {
        const recent = await this.groupRecent(p.targetId, 10, convId);
        if (recent && !recent.startsWith('这个群还没有')) {
          chatHistory = [recent, chatHistory].filter(Boolean).join('\n');
        }
      } catch {
        /* 群缓存读不到不影响主流程 */
      }
    }
    const images = [];
    if (cfg.visionEnabled) {
      for (const a of Array.isArray(p.attachments) ? p.attachments : []) {
        if (attachmentKind(a) !== '图片' || !a.url) continue;
        if (images.length >= 2) break;
        try {
          images.push(await imageToDataUrl(a.url, { timeoutMs: 15000, maxBytes: 4 * 1024 * 1024 }));
        } catch (e) {
          log(`[图片] 下载失败:${e?.message || e}`, 'warn');
        }
      }
      if (images.length) log(`[图片] 已读取 ${images.length} 张,将随消息一起发给模型`);
    } else if (incoming.attachments) {
      log('[图片] 图片识别未开启,只把附件名称带进上下文', 'info');
    }

    const result = await runAgent({
      cfg,
      core: this,
      convId,
      userText: body,
      images,
      meta: {
        botName: 'NOMO',
        nickname: p.nickname,
        p,
        quote: incoming.quote,
        chatHistory,
        attachments: incoming.attachments,
        hasImage: images.length > 0,
        markdown: cfg.markdownEnabled,
      },
      log,
    });

    const plain = toPlainText(result.reply);
    const outgoing = cfg.markdownEnabled ? String(result.reply || '').trim() : plain;
    // 投递策略:auto = 被动窗口内用被动回复,超窗自动改用主动消息;active = 始终主动
    const answerMode = cfg.answerDelivery === 'active' ? 'active' : (overWindow() ? 'active' : 'passive');
    const delivered = await this.reply(p, outgoing, { mode: answerMode, markdown: cfg.markdownEnabled });
    log(`[投递] 方式=${delivered.mode} 条数=${delivered.sent.length}`);

    this.appendMessages(convId, [
      { role: 'user', content: truncate([body, incoming.attachments, incoming.quote ? `[引用] ${incoming.quote}` : ''].filter(Boolean).join('\n'), 1500) },
      { role: 'assistant', content: truncate(plain, 2500) },
    ]);
    this.trimContext(convId);
    try {
      await this.maybeAutoCompress(convId);
    } catch (e) {
      log(`[上下文] 自动压缩失败 ${e?.message || e}`, 'warn');
    }

    await bumpMany(this.env, [
      ['replies', 1],
      ['tokens', result.usageTotal || 0],
      ['tools', result.toolTrace.length || 0],
    ]).catch(() => null);
    log(`[完成] 轮次=${result.rounds} 工具=${result.toolTrace.length} token=${result.usageTotal} 耗时=${Date.now() - started}ms 降级=${result.downgraded}`);
  },

  isAdmin(cfg, p) {
    const admins = cfg.settings.admin.openIds || [];
    if (admins.some((a) => a.openid === p.userId)) return true;
    if (cfg.settings.admin.groupAdmins && p.scene === 'group'
      && (p.memberRole === 'admin' || p.memberRole === 'owner')) return true;
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
    // 先看内存:一条消息要发回执+正文,每次都查 SQLite 是白费
    if (!force && this._token && this._tokenExp > now + 30000) return this._token;
    const rows = this.sql.exec("SELECT v, exp FROM kv WHERE k = 'qq_token'").toArray();
    if (!force && rows.length && Number(rows[0].exp) > now + 30000) {
      this._token = rows[0].v;
      this._tokenExp = Number(rows[0].exp);
      return this._token;
    }
    const cfg = await this.cfg();
    const r = await fetchAccessToken(cfg);
    this.sql.exec('INSERT INTO kv (k, v, exp) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, exp = excluded.exp',
      'qq_token', r.token, r.expiresAt);
    this._token = r.token;
    this._tokenExp = Number(r.expiresAt) || now + 7000000;
    return this._token;
  },

  async reply(p, text, opts = {}) {
    const first = await this.deliverOnce(p, text, opts.mode, opts);
    if (first.sent.length) return first;
    const other = opts.mode === 'active' ? 'passive' : 'active';
    await logWrite(this.env, 'warn', 'send', `${opts.mode || 'passive'} 一条都没发出去,改用 ${other} 重试`);
    const second = await this.deliverOnce(p, text, other, opts);
    await bump(this.env, `delivery_fallback_${other}`, 1).catch(() => null);
    return second;
  },

  async deliverOnce(p, text, mode = 'passive', opts = {}) {
    const cfg = await this.cfg();
    const token = await this.getToken();
    // 条数上限:QQ 同一条消息最多回复 4~5 次(单聊 4 / 群聊 5),回执已经用掉 1 次,这里留够余量
    const maxChunks = p.scene === 'c2c' ? 3 : 4;
    const chunks = sealFenceChunks(chunkText(text, cfg.chunkChars || 1500, maxChunks));
    if (!chunks.length) return { sent: [], errors: [], mode };
    const target = p.scene === 'c2c' ? { kind: 'c2c', id: p.targetId } : { kind: 'group', id: p.targetId };
    const r = await deliver(cfg, token, target, {
      chunks,
      mode,
      msgId: p.messageId,
      eventId: p.eventId,
      msgSeqStart: this.nextSeq(p),
      markdown: opts.markdown === true && cfg.markdownEnabled === true,
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

  async createPendingDeploy({ name, description, files, owner }, p = null) {
    const cfg = await this.cfg();
    const token = genId('ascii', 16);
    const now = Date.now();
    const expiresAt = now + 10 * 60 * 1000;
    const payload = { name, description, files, owner };
    this.sql.exec(
      'INSERT INTO pending (token, payload, conv_id, target_id, scene, msg_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      token, JSON.stringify(payload), p?.convId || '', p?.targetId || '', p?.scene || '', p?.messageId || '', now, expiresAt,
    );
    const base = String(cfg.publicBaseUrl || '').replace(/\/$/, '');
    return {
      token,
      url: base ? `${base}/confirm/${token}` : '',
      expiresAt,
    };
  },

  async getPending(token) {
    const t = String(token || '').trim();
    if (!t) return null;
    const rows = this.sql.exec('SELECT * FROM pending WHERE token = ?', t).toArray();
    if (!rows.length) return null;
    const row = rows[0];
    if (Number(row.expires_at) < Date.now()) {
      this.sql.exec('DELETE FROM pending WHERE token = ?', t);
      return null;
    }
    let payload = {};
    try {
      payload = JSON.parse(row.payload);
    } catch {
      payload = {};
    }
    return { ...row, payload };
  },

  async resolvePending(token, approve, { notify = true } = {}) {
    const row = await this.getPending(token);
    if (!row) return { error: '确认链接已过期或已经处理过了' };
    this.sql.exec('DELETE FROM pending WHERE token = ?', row.token);
    if (!approve) {
      if (notify) await this.notifyPending(row, '已取消这次部署。');
      return { ok: true, canceled: true };
    }
    const r = await this.createSite(row.payload);
    if (r.error) {
      if (notify) await this.notifyPending(row, `部署失败:${r.error}`);
      return { error: r.error };
    }
    if (notify) await this.notifyPending(row, `部署成功:${r.url}\n项目:${r.name}\n存活 ${r.ttlMinutes} 分钟。`);
    return { ok: true, site: r };
  },

  async notifyPending(row, text) {
    if (!row?.target_id || !row?.scene) return;
    const p = {
      scene: row.scene,
      targetId: row.target_id,
      messageId: row.msg_id,
      convId: row.conv_id,
      nickname: '系统',
    };
    try {
      await this.reply(p, text, { mode: 'passive' });
    } catch {
      /* 通知失败不影响确认结果 */
    }
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

  async sendDeployCard(p, pending, cfg) {
    if (!p?.targetId || !p?.scene) return { ok: false, error: '没有会话目标' };
    const token = await this.getToken();
    const admins = (cfg.settings.admin.openIds || []).map((x) => String(x.openid || '')).filter(Boolean);
    const permission = admins.length
      ? { type: 0, specify_user_ids: admins.slice(0, 10) }
      : { type: 1 };
    const buttons = [
      {
        id: 'approve',
        render_data: { label: '确认部署', visited_label: '已确认', style: 1 },
        action: {
          type: 1,
          permission,
          data: `approve:${pending.token}`,
          unsupport_tips: '请升级 QQ 版本后重试',
          reply: false,
        },
      },
      {
        id: 'cancel',
        render_data: { label: '取消', visited_label: '已取消', style: 0 },
        action: {
          type: 1,
          permission,
          data: `cancel:${pending.token}`,
          unsupport_tips: '请升级 QQ 版本后重试',
          reply: false,
        },
      },
    ];
    const keyboard = { content: { rows: [{ buttons }] } };
    const files = Array.isArray(pending.files) ? pending.files : [];
    const content = [
      '## 待确认部署',
      `**项目**:${String(pending.name || '未命名项目').slice(0, 60)}`,
      pending.description ? `**说明**:${String(pending.description).slice(0, 120)}` : '',
      `**文件**:${files.map((f) => f.path).slice(0, 6).join('、') || '—'}`,
      '',
      '确认后才会真正创建项目,10 分钟内有效。',
    ].filter(Boolean).join('\n');
    const common = {
      content,
      keyboard,
      msgId: p.messageId,
      msgSeq: this.nextSeq(p),
    };
    if (p.scene === 'group') {
      return await sendGroupMarkdown(cfg, token, { ...common, groupOpenid: p.targetId });
    }
    return await sendC2CMarkdown(cfg, token, { ...common, openid: p.targetId });
  },

  async handleInteraction(p) {
    const cfg = await this.cfg();
    const [action, token] = String(p.buttonData || '').split(':');
    if (!token || (action !== 'approve' && action !== 'cancel')) return;
    const adminP = {
      scene: p.scene,
      targetId: p.targetId,
      userId: p.userId,
      memberRole: p.memberRole || '',
      convId: p.convId,
    };
    const replyP = {
      scene: p.scene,
      targetId: p.targetId,
      eventId: p.eventId,
      convId: p.convId,
      nickname: '系统',
    };
    if (!this.isAdmin(cfg, adminP)) {
      await this.reply(replyP, '你没有权限操作这个部署确认。', { mode: 'passive' });
      return;
    }
    const r = await this.resolvePending(token, action === 'approve', { notify: false });
    if (r.error) {
      await this.reply(replyP, r.error, { mode: 'passive' });
      return;
    }
    const resultText = r.canceled
      ? '已取消这次部署,没有创建项目。'
      : `部署成功 ✅\n项目:${r.site.name}\n链接:${r.site.url}\n存活 ${r.site.ttlMinutes} 分钟。`;
    await this.reply(replyP, resultText, { mode: 'passive' });
    try {
      const follow = await runAgent({
        cfg,
        core: this,
        convId: p.convId,
        userText: `系统通知:${resultText}\n请根据这个结果继续处理,并把结果用自然语言告诉用户。`,
        meta: { botName: 'NOMO', nickname: '系统', p: replyP },
        log: (m, lv = 'info') => logWrite(this.env, lv, 'chat', m),
      });
      const text = String(follow.reply || '').trim();
      if (text) {
        await this.reply(replyP, text, { mode: 'passive', markdown: cfg.markdownEnabled });
        this.appendMessages(p.convId, [
          { role: 'user', content: `系统通知:${resultText}` },
          { role: 'assistant', content: truncate(text, 2500) },
        ]);
      }
    } catch (e) {
      await logWrite(this.env, 'warn', 'interaction', `确认后继续 Agent 失败:${e?.message || e}`);
    }
  },

  async handleMotd(p, args, cfg) {
    if (cfg.motdEnabled === false) {
      await this.reply(p, 'MOTD 查询已在面板关闭。');
      return;
    }
    const t = parseMotdTarget(args);
    if (t.error) {
      await this.reply(p, t.error);
      return;
    }
    const r = await queryMotd(cfg, t.host, t.port);
    const text = formatMotdText(r);
    if (r.ok && r.online && cfg.motdImageEnabled && cfg.motdImageApi) {
      const img = await fetchMotdImage(cfg, t.host, t.port);
      if (img) {
        try {
          if (!cfg.publicBaseUrl || !this.env.STORE) {
            await logWrite(this.env, 'warn', 'motd', '图片已获取,但缺少公开站点域名或 KV,改为只发文字');
          } else {
            const ext = img.contentType.includes('png') ? 'png'
              : img.contentType.includes('gif') ? 'gif'
                : img.contentType.includes('webp') ? 'webp' : 'jpg';
            const key = `motd_${genId('ascii', 12)}.${ext}`;
            await this.env.STORE.put(`media/${key}`, img.bytes, { expirationTtl: 900 });
            const publicUrl = `${cfg.publicBaseUrl.replace(/\/$/, '')}/media/${key}`;
            const token = await this.getToken();
            const target = p.scene === 'c2c' ? { kind: 'c2c', id: p.targetId } : { kind: 'group', id: p.targetId };
            const sent = await deliverMedia(cfg, token, target, {
              url: publicUrl, contentType: img.contentType, fileType: 1,
            }, {
              mode: 'passive', msgId: p.messageId, msgSeq: this.nextSeq(p),
            });
            if (sent.ok) {
              await this.reply(p, text, { mode: 'passive' });
              return;
            }
            await logWrite(this.env, 'warn', 'motd', `图片发送失败:${sent.error || 'unknown'}`);
          }
        } catch (e) {
          await logWrite(this.env, 'warn', 'motd', `图片发送异常:${e?.message || e}`);
        }
      }
    }
    await this.reply(p, text);
  },

  async handleAdminAction(p, action, args, cfg) {
    if (p.scene !== 'group') {
      await this.reply(p, '这个操作只能在群里使用。');
      return;
    }
    if (!this.isAdmin(cfg, p)) {
      await this.reply(p, '只有面板里配置的管理员才能使用这个操作。');
      return;
    }
    if (action === 'kick') {
      await this.reply(p, 'QQ 群机器人接口目前没有开放「踢人」,请在 QQ 群里手动移出成员。');
      return;
    }
    const m = String(args || '').match(/<@!?([^>]+)>/);
    const target = m ? m[1] : String(args || '').split(/\s+/)[0];
    if (!target) {
      await this.reply(p, '用法:/禁言 @某人 10(分钟) 或 /解禁 @某人');
      return;
    }
    const minMatch = String(args || '').match(/(\d+)\s*(分钟|分|min)?/i);
    const mins = Math.max(1, Math.min(30 * 24 * 60, Number(minMatch?.[1]) || 10));
    try {
      const token = await this.getToken();
      const r = action === 'unmute'
        ? await unmuteGroupMember(cfg, token, p.targetId, target)
        : await muteGroupMember(cfg, token, p.targetId, target, mins * 60);
      if (!r.ok) {
        await this.reply(p, `操作失败:${explainError(r.data)}`);
        return;
      }
      await this.reply(p, action === 'unmute' ? '已解除禁言。' : `已禁言 ${mins} 分钟。`);
    } catch (e) {
      await this.reply(p, `操作失败:${e?.message || e}`);
    }
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

export function parseCommand(text) {
  const t = String(text || '').trim();
  if (!t.startsWith('/')) return { name: '', args: '' };
  const m = t.match(/^\/([^\s]+)\s*([\s\S]*)$/);
  const raw = (m?.[1] || '').toLowerCase();
  const args = (m?.[2] || '').trim();
  const map = {
    ai: 'ai', a: 'ai', ask: 'ai', 问: 'ai',
    帮助: 'help', help: 'help', 菜单: 'menu', 指令: 'menu', '?': 'help', menu: 'menu',
    delete: 'delete', clear: 'delete', reset: 'delete', 清空: 'delete', 重置: 'delete',
    压缩: 'compress', compress: 'compress', 总结: 'compress', compact: 'compress',
    记忆: 'memory', memory: 'memory', 记住: 'memory',
    状态: 'status', status: 'status',
    motd: 'motd', 服务器: 'motd', 查服务器: 'motd', 服务器状态: 'motd',
    禁言: 'mute', mute: 'mute', 解禁: 'unmute', unmute: 'unmute', 踢人: 'kick', kick: 'kick',
    查信息: 'info', info: 'info', whoami: 'info', 我的信息: 'info', 查id: 'info',
  };
  return { name: map[raw] || '', args };
}

export const NO_ARG_COMMANDS = new Set(['help', 'menu', 'status', 'memory', 'delete', 'compress', 'info']);

/**
 * 只认两种 AI 触发:
 *   AI 你好 / AI<空格>你好
 *   /AI 你好
 * 正文必须有内容;「你看这个AI」「AI你好」都不算。
 */
export function parseAiPrefix(text) {
  const s = String(text || '');
  const m = s.match(/^\/ai[ \t]+([\s\S]*)$/i) || s.match(/^AI[ \t]+([\s\S]*)$/i);
  return m && m[1].trim() ? m[1].trim() : null;
}

function genId(charset = 'ascii', len = 8) {
  for (let i = 0; i < 20; i++) {
    const s = genSiteId(len, charset);
    if (s && !isReservedPath(s)) return s;
  }
  return Math.random().toString(36).slice(2, 2 + len).padEnd(len, '0');
}

function flattenElements(elements, depth = 0) {
  const out = [];
  for (const el of Array.isArray(elements) ? elements : []) {
    const type = Number(el?.message_type) || 0;
    const tag = type === 103 ? '引用' : type === 102 ? '聊天记录' : type === 3 ? '卡片' : '';
    const who = el?.author?.nickname || el?.author?.username || el?.author?.member_openid || '';
    const content = String(el?.content || '').trim();
    if (tag || content) out.push(`${'  '.repeat(depth)}${tag ? `[${tag}] ` : ''}${who ? `${who}:` : ''}${content}`);
    if (Array.isArray(el?.attachments) && el.attachments.length) out.push(`${'  '.repeat(depth)}${describeAttachments(el.attachments)}`);
    if (Array.isArray(el?.msg_elements) && el.msg_elements.length) out.push(...flattenElements(el.msg_elements, depth + 1));
  }
  return out.filter(Boolean);
}

function findElement(elements, type) {
  for (const el of Array.isArray(elements) ? elements : []) {
    if (Number(el?.message_type) === type) return el;
    if (Array.isArray(el?.msg_elements)) {
      const found = findElement(el.msg_elements, type);
      if (found) return found;
    }
  }
  return null;
}

function incomingContext(p) {
  const elements = Array.isArray(p?.msgElements) ? p.msgElements : [];
  const quoteEl = findElement(elements, 103);
  const historyEl = findElement(elements, 102);
  const quote = quoteEl ? flattenElements([quoteEl]).join('\n').slice(0, 2000) : '';
  const history = historyEl ? flattenElements([historyEl]).join('\n').slice(0, 3000) : '';
  const attachments = describeAttachments(p?.attachments);
  return { quote, history, attachments };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
