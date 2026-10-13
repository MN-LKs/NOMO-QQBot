import { loadConfig } from '../config.js';
import { SCHEMA } from './schema.js';
import { genSiteId, isReservedPath } from '../util/id.js';
import { chunkText, safeJson, toPlainText, truncate } from '../util/text.js';
import { fetchAccessToken, deliver } from '../qq/api.js';
import { runAgent } from '../agent/loop.js';
import { buildCompressPrompt, buildHelpText } from '../agent/prompt.js';
import { chatWithFallback } from '../agent/llm.js';

const JOB_MAX_PER_ALARM = 25;
const ALARM_DEADLINE_MS = 12 * 60 * 1000;
const EVENT_TTL_MS = 10 * 60 * 1000;

export class BotCore {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.cfg = loadConfig(env);
    this.sql = ctx.storage.sql;
    for (const stmt of SCHEMA) this.sql.exec(stmt);
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
        case '/enqueue': {
          const r = this.enqueue(body || {});
          return json(r);
        }
        case '/site/get': {
          const site = this.getSite(url.searchParams.get('id') || '');
          return json({ site });
        }
        case '/site/list':
          return json({ sites: this.listSites() });
        case '/site/delete':
          return json({ ok: this.deleteSite((body || {}).id || '') });
        case '/data/get': {
          const v = this.dataGet(url.searchParams.get('id') || '', url.searchParams.get('key') || '');
          return json({ value: v });
        }
        case '/data/put': {
          const r = this.dataPut((body || {}).id || '', (body || {}).key || '', (body || {}).value);
          return json(r);
        }
        case '/context/clear': {
          this.clearContext((body || {}).convId || '');
          return json({ ok: true });
        }
        case '/context/compress': {
          const r = await this.compressContext((body || {}).convId || '');
          return json(r);
        }
        case '/status':
          return json(this.status());
        case '/tick': {
          await this.tick();
          return json({ ok: true });
        }
        default:
          return json({ error: 'not found', path: p }, 404);
      }
    } catch (e) {
      return json({ error: String(e?.message || e) }, 500);
    }
  }

  async alarm() {
    try {
      await this.tick();
    } catch (e) {
      console.error('[alarm] 异常', e?.stack || e);
    }
  }

  async tick() {
    const deadline = Date.now() + ALARM_DEADLINE_MS;
    this.purgeExpired();

    let done = 0;
    while (done < JOB_MAX_PER_ALARM && Date.now() < deadline) {
      const job = this.claimNextJob();
      if (!job) break;
      await this.runJob(job);
      done++;
    }

    this.armAlarm();
  }

  armAlarm() {
    const pending = this.countJobs('pending') + this.countJobs('running');
    if (pending > 0) {
      this.ctx.storage.setAlarm(Date.now() + 500);
      return;
    }
    const nextExpiry = this.nextSiteExpiry();
    if (nextExpiry) this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, nextExpiry + 1000));
  }

  enqueue(payload) {
    const id = payload.eventId || `j_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const existing = this.sql
      .exec('SELECT id FROM jobs WHERE id = ?', id).toArray();
    if (existing.length) return { ok: true, duplicate: true, id };
    this.sql.exec(
      'INSERT INTO jobs (id, kind, payload, status, created_at) VALUES (?, ?, ?, ?, ?)',
      id, payload.kind || 'message', JSON.stringify(payload), 'pending', Date.now(),
    );
    this.armAlarm();
    return { ok: true, id };
  }

  claimNextJob() {
    const rows = this.sql
      .exec("SELECT * FROM jobs WHERE status = 'pending' ORDER BY created_at LIMIT 1").toArray();
    if (!rows.length) return null;
    const row = rows[0];
    this.sql.exec("UPDATE jobs SET status = 'running', started_at = ? WHERE id = ?", Date.now(), row.id);
    return row;
  }

  finishJob(id, error) {
    this.sql.exec('UPDATE jobs SET status = ?, error = ? WHERE id = ?', error ? 'failed' : 'done', error || null, id);
    this.sql.exec('DELETE FROM jobs WHERE created_at < ?', Date.now() - 3600_000);
  }

  countJobs(status) {
    const r = this.sql.exec('SELECT COUNT(*) AS n FROM jobs WHERE status = ?', status).toArray();
    return r[0]?.n ?? 0;
  }

  async runJob(job) {
    let payload;
    try {
      payload = JSON.parse(job.payload);
    } catch {
      this.finishJob(job.id, 'payload 不是合法 JSON');
      return;
    }
    try {
      await this.handleMessage(payload);
      this.finishJob(job.id);
    } catch (e) {
      console.error('[job] 失败', e?.stack || e);
      this.finishJob(job.id, String(e?.message || e).slice(0, 300));
      try {
        await this.notifyFailure(payload, e);
      } catch {
  }
    }
  }

  async handleMessage(p) {
    const cfg = this.cfg;
    const convId = p.convId;
    const text = String(p.text || '').trim();
    const log = (...a) => console.log(...a);

    log(`[收到] conv=${convId} user=${p.nickname || p.userId} text=${truncate(text, 120)}`);

    const cmd = parseCommand(text);
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
      const s = this.status();
      const c = this.getContext(convId);
      await this.reply(p, [
        '📊 当前状态',
        `· 在线部署:${s.sites}/${cfg.maxSites}`,
        `· 排队任务:${s.pending} 待处理 / ${s.running} 执行中`,
        `· 本会话:摘要 ${c.summary ? `${c.summary.length} 字` : '无'},历史 ${c.messages.length} 条,记忆 ${this.memList(convId).length} 条`,
        `· 模型:${cfg.llmModel}(思考 ${cfg.reasoningEffort})`,
        `· 部署存活:${Math.round(cfg.siteTtlSeconds / 60)} 分钟`,
      ].join('\n'));
      return;
    }

    const body = cmd.name === 'ai' ? cmd.args : text;
    if (!body) {
      await this.reply(p, buildHelpText(cfg));
      return;
    }

    await this.reply(p, '🤖 Agent 正在运行,请稍等…');

    const result = await runAgent({
      cfg,
      core: this,
      convId,
      userText: body,
      meta: { botName: 'NB-AI', nickname: p.nickname },
      log,
    });

    const plain = toPlainText(result.reply);
    const answerMode = p.scene === 'c2c' ? 'passive' : cfg.answerDelivery;
    const delivered = await this.reply(p, plain, { mode: answerMode });
    console.log(`[投递] 方式=${delivered.mode} 条数=${delivered.sent.length}`);

    this.appendMessages(convId, [
      { role: 'user', content: truncate(body, 1500) },
      { role: 'assistant', content: truncate(plain, 2500) },
    ]);
    this.trimContext(convId);
    try {
      await this.maybeAutoCompress(convId);
    } catch (e) {
      console.warn('[上下文] 自动压缩失败', e?.message || e);
    }

    console.log(`[完成] conv=${convId} 轮次=${result.rounds} 工具=${result.toolTrace.length} `
      + `token=${result.usageTotal} 耗时=${result.elapsedMs}ms 降级=${result.downgraded}`);
  }

  async notifyFailure(p, e) {
    await this.reply(p, `😵 处理这条消息时出错了:${truncate(String(e?.message || e), 150)}\n稍后再试一次吧。`);
  }

  async getToken() {
    const cached = this.kvGet('qq_token');
    if (cached) return cached;
    const r = await fetchAccessToken(this.cfg);
    this.kvSet('qq_token', r.token, r.expiresAt);
    return r.token;
  }

  async reply(p, text, opts = {}) {
    const first = await this.deliverOnce(p, text, opts.mode);
    if (first.sent.length) return first;

    const other = opts.mode === 'active' ? 'passive' : 'active';
    console.warn(`[发送] ${opts.mode || 'passive'} 一条都没发出去,改用 ${other} 重试`);
    const second = await this.deliverOnce(p, text, other);
    this.bumpStat(`delivery_fallback_${other}`, 1);
    return second;
  }

  async deliverOnce(p, text, mode = 'passive') {
    const cfg = this.cfg;
    const token = await this.getToken();
    const chunks = chunkText(text, 800, 5);
    if (!chunks.length) return { sent: [], errors: [], mode };
    const target = p.scene === 'c2c'
      ? { kind: 'c2c', id: p.targetId }
      : { kind: 'group', id: p.targetId };

    const r = await deliver(cfg, token, target, {
      chunks,
      mode,
      msgId: p.messageId,
      msgSeqStart: this.nextSeq(p),
    });

    if (r.errors.length) console.warn(`[发送·${mode}] 有错误: ${r.errors.join(' | ')}`);
    this.bumpStat(mode === 'active' ? 'messages_active' : 'messages_passive', r.sent.length);
    this.bumpStat('messages_sent', r.sent.length);
    return r;
  }

  nextSeq(p) {
    const key = `seq_${p.convId}`;
    const n = (parseInt(this.kvGet(key), 10) || 0) + 1;
    this.kvSet(key, String(n), Date.now() + 6 * 60 * 1000);
    return n;
  }

  getContext(convId) {
    const c = this.sql.exec('SELECT * FROM conv WHERE id = ?', convId).toArray();
    const msgs = this.sql
      .exec('SELECT role, content FROM msg WHERE conv_id = ? ORDER BY seq', convId).toArray();
    return {
      summary: c[0]?.summary || '',
      messages: msgs.map((m) => ({ role: m.role, content: m.content })),
    };
  }

  appendMessages(convId, list) {
    const now = Date.now();
    this.sql.exec(
      'INSERT INTO conv (id, summary, updated_at) VALUES (?, NULL, ?) '
      + 'ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at',
      convId, now,
    );
    const r = this.sql.exec('SELECT COALESCE(MAX(seq), 0) AS s FROM msg WHERE conv_id = ?', convId).toArray();
    let seq = r[0]?.s || 0;
    for (const m of list) {
      seq++;
      this.sql.exec(
        'INSERT INTO msg (conv_id, seq, role, content, ts) VALUES (?, ?, ?, ?, ?)',
        convId, seq, m.role, m.content, now,
      );
    }
    return seq;
  }

  trimContext(convId) {
    const keep = this.cfg.keepMessages;
    const all = this.sql
      .exec('SELECT seq FROM msg WHERE conv_id = ? ORDER BY seq', convId).toArray();
    if (all.length <= keep) return;
    const cut = all[all.length - keep].seq;
    this.sql.exec('DELETE FROM msg WHERE conv_id = ? AND seq < ?', convId, cut);
  }

  clearContext(convId) {
    this.sql.exec('DELETE FROM msg WHERE conv_id = ?', convId);
    this.sql.exec('DELETE FROM conv WHERE id = ?', convId);
    this.sql.exec('DELETE FROM mem WHERE conv_id = ?', convId);
  }

  setSummary(convId, summary) {
    this.sql.exec(
      'INSERT INTO conv (id, summary, updated_at) VALUES (?, ?, ?) '
      + 'ON CONFLICT(id) DO UPDATE SET summary = excluded.summary, updated_at = excluded.updated_at',
      convId, summary, Date.now(),
    );
  }

  async compressContext(convId) {
    const cur = this.getContext(convId);
    if (!cur.messages.length && !cur.summary) return { ok: false, error: '这个会话还没有聊天记录' };

    const transcript = cur.messages
      .map((m) => `${m.role === 'user' ? '用户' : '我'}: ${truncate(m.content, 1200)}`)
      .join('\n');

    const input = (cur.summary ? `已有摘要:\n${cur.summary}\n\n` : '') + `聊天记录:\n${transcript}`;
    const keep = Math.min(4, cur.messages.length);
    const tail = cur.messages.slice(cur.messages.length - keep);

    const resp = await chatWithFallback(this.cfg, [
      { role: 'system', content: buildCompressPrompt() },
      { role: 'user', content: input },
    ], null, { effort: 'low', timeoutMs: 60000 });

    const summary = truncate(resp.content.trim(), this.cfg.summaryChars);
    if (!summary) return { ok: false, error: '模型没有产出摘要,稍后再试' };

    this.sql.exec('DELETE FROM msg WHERE conv_id = ?', convId);
    this.setSummary(convId, summary);
    if (tail.length) this.appendMessages(convId, tail);
    this.bumpStat('compressions', 1);
    return { ok: true, summary, kept: tail.length };
  }

  async maybeAutoCompress(convId) {
    const cur = this.getContext(convId);
    const size = cur.summary.length + cur.messages.reduce((n, m) => n + m.content.length, 0);
    if (size < this.cfg.compressChars) return false;
    const r = await this.compressContext(convId);
    return !!r.ok;
  }

  createSite({ name, description, files, owner }) {
    const cfg = this.cfg;
    const now = Date.now();
    this.purgeExpired(now);

    let id = null;
    for (let i = 0; i < 12; i++) {
      const candidate = genSiteId(cfg.idLen, cfg.idCharset);
      if (isReservedPath(candidate)) continue;
      const exists = this.sql.exec('SELECT id FROM sites WHERE id = ?', candidate).toArray();
      if (!exists.length) {
        id = candidate;
        break;
      }
    }
    if (!id) return { error: '生成部署 ID 失败,请重试' };

    this.sql.exec(
      'INSERT INTO sites (id, name, description, owner, created_at, updated_at, expires_at, files) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id, String(name || '未命名项目').slice(0, 60), String(description || '').slice(0, 200),
      owner || null, now, now, now + cfg.siteTtlSeconds * 1000, JSON.stringify(files),
    );

    const evicted = this.enforceLimit(id);
    this.bumpStat('sites_created', 1);
    this.armAlarm();
    return { site: this.siteView(id), count: this.countSites(), evicted };
  }

  updateSite(id, { name, files }) {
    const now = Date.now();
    const row = this.sql.exec('SELECT * FROM sites WHERE id = ?', id).toArray()[0];
    if (!row) return { error: `没找到 ID 为 ${id} 的部署,先用 list_sites 看一下有哪些` };

    let merged = safeJson(row.files, []) || [];
    if (files && files.length) {
      for (const f of files) {
        const i = merged.findIndex((x) => x.path === f.path);
        if (i >= 0) merged[i] = f;
        else merged.push(f);
      }
    }
    const total = merged.reduce((n, f) => n + f.content.length, 0);
    if (total > this.cfg.maxSiteBytes) {
      return { error: `代码总量 ${total} 字节超过上限 ${this.cfg.maxSiteBytes},请精简` };
    }

    this.sql.exec(
      'UPDATE sites SET name = ?, files = ?, updated_at = ?, expires_at = ? WHERE id = ?',
      name ? String(name).slice(0, 60) : row.name,
      JSON.stringify(merged),
      now,
      now + this.cfg.siteTtlSeconds * 1000,
      id,
    );
    this.bumpStat('sites_updated', 1);
    this.armAlarm();
    return { site: this.siteView(id) };
  }

  getSite(id) {
    if (!id) return null;
    const row = this.sql.exec('SELECT * FROM sites WHERE id = ?', String(id)).toArray()[0];
    if (!row) return null;
    return this.siteView(row.id, row);
  }

  siteView(id, row) {
    const r = row || this.sql.exec('SELECT * FROM sites WHERE id = ?', id).toArray()[0];
    if (!r) return null;
    const files = safeJson(r.files, []) || [];
    return {
      id: r.id,
      name: r.name,
      description: r.description || '',
      url: this.siteUrl(r.id),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      expiresAt: r.expires_at,
      files: files.map((f) => ({ path: f.path, content: f.content })),
      bytes: files.reduce((n, f) => n + f.content.length, 0),
    };
  }

  siteUrl(id) {
    const base = this.cfg.publicBaseUrl;
    const path = `/${encodeURIComponent(id)}`;
    return base ? base + path : path;
  }

  listSites() {
    this.purgeExpired();
    return this.sql.exec('SELECT id FROM sites ORDER BY updated_at DESC').toArray()
      .map((r) => this.siteView(r.id))
      .filter(Boolean);
  }

  countSites() {
    const r = this.sql.exec('SELECT COUNT(*) AS n FROM sites').toArray();
    return r[0]?.n ?? 0;
  }

  deleteSite(id) {
    if (!id) return false;
    const before = this.countSites();
    this.sql.exec('DELETE FROM sites WHERE id = ?', String(id));
    this.sql.exec('DELETE FROM sdata WHERE site_id = ?', String(id));
    const after = this.countSites();
    if (after < before) this.bumpStat('sites_deleted', 1);
    return after < before;
  }

  enforceLimit(keepId) {
    const max = this.cfg.maxSites;
    let evicted = null;
    let guard = 0;
    while (this.countSites() > max && guard++ < 20) {
      const rows = this.sql
        .exec('SELECT id FROM sites WHERE id != ? ORDER BY updated_at ASC LIMIT 1', keepId).toArray();
      if (!rows.length) break;
      const victim = this.siteView(rows[0].id);
      this.deleteSite(rows[0].id);
      evicted = victim ? { id: victim.id, name: victim.name } : { id: rows[0].id, name: '?' };
    }
    return evicted;
  }

  purgeExpired(now = Date.now()) {
    const rows = this.sql.exec('SELECT id FROM sites WHERE expires_at <= ?', now).toArray();
    for (const r of rows) {
      this.sql.exec('DELETE FROM sites WHERE id = ?', r.id);
      this.sql.exec('DELETE FROM sdata WHERE site_id = ?', r.id);
    }
    if (rows.length) console.log(`[清理] 删除 ${rows.length} 个过期部署`);
    return rows.length;
  }

  nextSiteExpiry() {
    const r = this.sql.exec('SELECT MIN(expires_at) AS t FROM sites').toArray();
    return r[0]?.t ?? null;
  }

  dataGet(siteId, key) {
    if (!this.getSite(siteId)) return null;
    const r = this.sql
      .exec('SELECT v FROM sdata WHERE site_id = ? AND k = ?', siteId, String(key)).toArray();
    return r[0]?.v ?? null;
  }

  dataPut(siteId, key, value) {
    if (!this.getSite(siteId)) return { error: '站点不存在或已过期' };
    const k = String(key).slice(0, 64);
    const v = typeof value === 'string' ? value : JSON.stringify(value);
    if (v.length > 100000) return { error: '单个键的值不能超过 100 KB' };
    const count = this.sql.exec('SELECT COUNT(*) AS n FROM sdata WHERE site_id = ?', siteId).toArray()[0]?.n ?? 0;
    if (count > 200 && !this.sql.exec('SELECT 1 FROM sdata WHERE site_id = ? AND k = ?', siteId, k).toArray().length) {
      return { error: '这个站点的数据键太多了(上限 200)' };
    }
    this.sql.exec(
      'INSERT INTO sdata (site_id, k, v, updated_at) VALUES (?, ?, ?, ?) '
      + 'ON CONFLICT(site_id, k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at',
      siteId, k, v, Date.now(),
    );
    return { ok: true };
  }

  memSet(convId, key, value) {
    const k = String(key).trim().slice(0, 40);
    const v = String(value).trim().slice(0, 500);
    if (!k || !v) return { error: '要记的内容不能为空' };
    const n = this.sql.exec('SELECT COUNT(*) AS n FROM mem WHERE conv_id = ?', convId).toArray()[0]?.n ?? 0;
    const exists = this.sql.exec('SELECT 1 FROM mem WHERE conv_id = ? AND k = ?', convId, k).toArray().length;
    if (!exists && n >= 40) return { error: '这个会话记住的东西太多了(上限 40 条),先忘掉几条' };
    this.sql.exec(
      'INSERT INTO mem (conv_id, k, v, updated_at) VALUES (?, ?, ?, ?) '
      + 'ON CONFLICT(conv_id, k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at',
      convId, k, v, Date.now(),
    );
    this.bumpStat('memories_saved', 1);
    return { ok: true, key: k, value: v };
  }

  memList(convId) {
    return this.sql
      .exec('SELECT k, v, updated_at FROM mem WHERE conv_id = ? ORDER BY updated_at DESC', convId)
      .toArray()
      .map((r) => ({ key: r.k, value: r.v, updatedAt: r.updated_at }));
  }

  memDel(convId, key) {
    const k = String(key || '').trim();
    if (!k) return false;
    const before = this.memList(convId).length;
    this.sql.exec('DELETE FROM mem WHERE conv_id = ? AND k = ?', convId, k);
    return this.memList(convId).length < before;
  }

  memClear(convId) {
    this.sql.exec('DELETE FROM mem WHERE conv_id = ?', convId);
  }

  kvGet(k) {
    const r = this.sql.exec('SELECT v, exp FROM kv WHERE k = ?', k).toArray()[0];
    if (!r) return null;
    if (r.exp && r.exp < Date.now()) {
      this.sql.exec('DELETE FROM kv WHERE k = ?', k);
      return null;
    }
    return r.v;
  }

  kvSet(k, v, exp) {
    this.sql.exec(
      'INSERT INTO kv (k, v, exp) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, exp = excluded.exp',
      k, v, exp || null,
    );
  }

  seenEvent(eventId) {
    if (!eventId) return false;
    const k = `ev_${eventId}`;
    if (this.kvGet(k)) return true;
    this.kvSet(k, '1', Date.now() + EVENT_TTL_MS);
    return false;
  }

  bumpStat(k, n = 1) {
    this.sql.exec(
      'INSERT INTO stats (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = v + excluded.v',
      k, n,
    );
  }

  status() {
    const stats = {};
    for (const r of this.sql.exec('SELECT k, v FROM stats').toArray()) stats[r.k] = r.v;
    return {
      sites: this.countSites(),
      pending: this.countJobs('pending'),
      running: this.countJobs('running'),
      failed: this.countJobs('failed'),
      stats,
      now: Date.now(),
    };
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export function parseCommand(text) {
  const t = String(text || '').trim();
  const m = /^[/／]([a-zA-Z\u4e00-\u9fa5]+)\s*([\s\S]*)$/.exec(t);
  if (!m) return { name: '', args: t };
  const raw = m[1].toLowerCase();
  const alias = {
    ai: 'ai', 'a': 'ai', '问': 'ai', 'ask': 'ai',
    help: 'help', '帮助': 'help', '菜单': 'help', '指令': 'help', '?': 'help',
    delete: 'delete', 'del': 'delete', '清除': 'delete', '清空': 'delete', 'reset': 'delete', '删除': 'delete',
    compress: 'compress', '压缩': 'compress', '总结': 'compress', 'compact': 'compress',
    status: 'status', '状态': 'status', 'info': 'status',
    memory: 'memory', '记忆': 'memory', '备忘': 'memory', 'memo': 'memory',
  };
  return { name: alias[raw] ?? '', args: m[2].trim() };
}
