import { calc, formatNumber } from '../util/calc.js';
import { htmlToText } from '../util/html.js';
import { truncate } from '../util/text.js';
import { webSearch, readPage } from './search.js';
import { parseMotdTarget, queryMotd, formatMotdText } from './motd.js';
import { generateImage } from './models.js';
import { saveExt, loadExts, safeToolName } from './exts.js';
import { invalidate as invalidateSettings } from '../store/settings.js';
import { execBackend, moduleResultText, sandboxFetch } from '../core/backend.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

const TOOL_LIST = 'calc, now, motd, web_search, fetch_url, group_recent, group_find, deploy_site, update_site, list_sites, read_site, delete_site, fs_write, fs_read, fs_list, fs_edit, fs_delete, fs_deploy, remember, recall, forget, random, encode, query_dashboard';

function fmtTime(d, offsetHours) {
  const t = new Date(d.getTime() + offsetHours * 3600_000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const week = ['日', '一', '二', '三', '四', '五', '六'][t.getUTCDay()];
  return {
    text: `${t.getUTCFullYear()}年${p(t.getUTCMonth() + 1)}月${p(t.getUTCDate())}日 星期${week} `
      + `${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}`,
    iso: `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}T`
      + `${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}`,
    tz: offsetHours >= 0 ? `UTC+${offsetHours}` : `UTC${offsetHours}`,
  };
}

// 没配「站点域名」时 siteUrl 只给相对路径;这里补一句提醒,免得模型把半截链接发给用户
function siteLink(cfg, url) {
  const u = String(url || '');
  if (/^https?:\/\//i.test(u)) return u;
  return `${u} (完整网址需要管理员先在面板「设置 → 站点域名」里填写当前网址)`;
}

function assertPublicUrl(raw) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    throw new Error('网址格式不对');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('只支持 http/https');
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')
    || host.endsWith('.internal') || host === 'metadata.google.internal') {
    throw new Error('不允许访问内网地址');
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b] = host.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)
      || (a === 169 && b === 254) || a >= 224) {
      throw new Error('不允许访问内网地址');
    }
  }
  if (host === '[::1]' || host.startsWith('fd') || host.startsWith('fe80')) {
    throw new Error('不允许访问内网地址');
  }
  return u;
}

async function fetchText(url, { timeoutMs = 20000, maxBytes = 800000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/json;q=0.9,*/*;q=0.8' },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    if (buf.byteLength > maxBytes) throw new Error(`页面太大(${buf.byteLength} 字节),已放弃`);
    return new TextDecoder('utf-8', { fatal: false }).decode(buf);
  } finally {
    clearTimeout(timer);
  }
}

/** 查询中转站用量面板(地址在 Agent 配置里填,不写死) */
export async function queryDashboard(cfg) {
  const url = String(cfg.dashboardUrl || '').trim();
  if (!url) return '还没有配置中转站用量面板地址,请管理员在「Agent 配置 → 大模型接口 → 中转站用量面板地址」里填写。';
  let json;
  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': UA },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return `中转站用量接口返回 HTTP ${res.status},可能地址不对或服务暂时不可用。`;
    json = await res.json();
  } catch (e) {
    return `查询中转站用量失败:${e?.message || e}。可以稍后再试,或者告诉用户暂时查不了。`;
  }
  return formatDashboard(json);
}

function pickArray(obj, paths) {
  for (const path of paths) {
    let cur = obj;
    for (const part of path.split('.')) {
      cur = cur?.[part];
    }
    if (Array.isArray(cur) && cur.length) return cur;
  }
  return [];
}

function numOf(...vals) {
  for (const v of vals) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function metricText(label, requests, tokens, users) {
  const parts = [];
  if (requests !== null) parts.push(`${fmtNum(requests)} 次请求`);
  if (tokens !== null) parts.push(`${fmtNum(tokens)} tokens`);
  if (users !== null) parts.push(`${fmtNum(users)} 人`);
  return parts.length ? `· ${label}:${parts.join(' / ')}` : '';
}

export function formatDashboard(json) {
  const d = json?.data && typeof json.data === 'object' ? json.data : json;
  const rt = d?.realtime || {};
  const w = d?.windows || {};
  const today = w.today || d?.today || {};
  const week = w.week || w.this_week || d?.week || {};
  const month = w.month || d?.month || {};
  const lines = ['📊 AI 中转站用量(数据来自中转站面板)'];

  const totalReq = numOf(rt.all_requests, d?.total_requests, d?.all_requests, d?.requests);
  const totalTok = numOf(rt.all_tokens, d?.total_tokens, d?.all_tokens, d?.tokens);
  const totalLine = metricText('累计请求', totalReq, totalTok);
  if (totalLine) lines.push(totalLine);

  const todayLine = metricText('今日', numOf(today.requests, today.calls), numOf(today.tokens), numOf(today.users, today.active_users));
  if (todayLine) lines.push(todayLine);
  const weekLine = metricText('本周', numOf(week.requests, week.calls), numOf(week.tokens), numOf(week.users, week.active_users));
  if (weekLine) lines.push(weekLine);
  const monthLine = metricText('本月', numOf(month.requests, month.calls), numOf(month.tokens), numOf(month.users, month.active_users));
  if (monthLine) lines.push(monthLine);

  const quota = numOf(d?.totals?.quota, d?.quota, d?.remaining_quota);
  if (quota !== null && quota > 0) {
    lines.push(`· 剩余额度:${fmtNum(quota)} 点(约 $${(quota / 500000).toFixed(2)},换算以面板为准)`);
  }

  const models = pickArray(d, [
    'model_ranking', 'modelRanking', 'model_stats', 'modelStats',
    'rankings.models', 'stats.models', 'models',
  ]);
  if (models.length) {
    lines.push('· 模型排行:');
    models.slice(0, 8).forEach((m, i) => {
      const name = m?.model_name || m?.model || m?.name || m?.id || '?';
      const req = numOf(m?.requests, m?.count, m?.calls, m?.total);
      const tok = numOf(m?.tokens, m?.total_tokens);
      lines.push(`  ${i + 1}. ${name}${req !== null ? ` · ${fmtNum(req)} 次` : ''}${tok !== null ? ` · ${fmtNum(tok)} tokens` : ''}`);
    });
  }

  const users = pickArray(d, [
    'user_ranking', 'userRanking', 'user_stats', 'userStats',
    'rankings.users', 'stats.users', 'users',
  ]);
  if (users.length) {
    lines.push('· 用户排行:');
    users.slice(0, 8).forEach((u, i) => {
      const name = u?.username || u?.user || u?.name || u?.email || u?.id || '?';
      const req = numOf(u?.requests, u?.count, u?.calls, u?.total);
      const tok = numOf(u?.tokens, u?.total_tokens);
      lines.push(`  ${i + 1}. ${name}${req !== null ? ` · ${fmtNum(req)} 次` : ''}${tok !== null ? ` · ${fmtNum(tok)} tokens` : ''}`);
    });
  }

  const recent = Array.isArray(d?.recent) ? d.recent.slice(0, 8) : [];
  if (recent.length) {
    lines.push('· 最近调用:');
    const nowSec = Number(rt.now) || Math.floor(Date.now() / 1000);
    for (const r of recent) {
      const ago = r.created_at ? `${timeAgo(nowSec - Number(r.created_at))}前` : '';
      lines.push(`  · ${r.username || '?'} | ${r.model_name || '?'} | ${fmtNum(r.tokens)} tokens${ago ? ` | ${ago}` : ''}`);
    }
  }

  if (lines.length === 1) {
    lines.push('· 接口没有返回可识别的用量字段;可以检查面板地址是否正确,或把接口原始字段发给管理员。');
  }
  return lines.join('\n');
}

function fmtNum(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return String(n);
  if (Math.abs(v) >= 1e8) return `${(v / 1e8).toFixed(2)} 亿`;
  if (Math.abs(v) >= 1e4) return `${(v / 1e4).toFixed(1)} 万`;
  return String(v);
}

function timeAgo(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时`;
  return `${Math.floor(s / 86400)} 天`;
}


function b64encode(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function b64decode(text) {
  const bin = atob(String(text).replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function hexEncode(text) {
  return [...new TextEncoder().encode(text)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexDecode(text) {
  const clean = String(text).replace(/\s+/g, '');
  if (clean.length % 2) throw new Error('hex 长度必须是偶数');
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  if ([...bytes].some((b) => Number.isNaN(b))) throw new Error('hex 含非法字符');
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function doEncode(action, text) {
  const t = String(text ?? '');
  if (!t) throw new Error('内容不能为空');
  switch (action) {
    case 'base64_encode': return b64encode(t);
    case 'base64_decode': return b64decode(t);
    case 'url_encode': return encodeURIComponent(t);
    case 'url_decode': return decodeURIComponent(t);
    case 'hex_encode': return hexEncode(t);
    case 'hex_decode': return hexDecode(t);
    case 'json_pretty': return JSON.stringify(JSON.parse(t), null, 2);
    case 'json_minify': return JSON.stringify(JSON.parse(t));
    default: throw new Error(`不认识的动作 ${action}`);
  }
}

function doRandom(a) {
  const n = Math.max(1, Math.min(20, Number(a.count) || 1));
  const choices = Array.isArray(a.choices) ? a.choices.map((x) => String(x)).filter(Boolean) : [];
  const picks = [];
  if (choices.length) {
    for (let i = 0; i < n; i++) picks.push(choices[Math.floor(Math.random() * choices.length)]);
    return n === 1 ? `抽中了:${picks[0]}` : `随机抽 ${n} 次:${picks.join('、')}`;
  }
  let min = Number.isFinite(Number(a.min)) ? Math.ceil(Number(a.min)) : 1;
  let max = Number.isFinite(Number(a.max)) ? Math.floor(Number(a.max)) : 100;
  if (max < min) [min, max] = [max, min];
  if (max - min > 1e9) throw new Error('范围太大了');
  for (let i = 0; i < n; i++) picks.push(min + Math.floor(Math.random() * (max - min + 1)));
  return n === 1 ? `随机结果:${picks[0]}` : `随机 ${n} 个:${picks.join('、')}`;
}

export async function executeTool(name, args, ctx) {
  const a = args && typeof args === 'object' ? args : {};
  try {
    switch (name) {
      case 'calc': {
        const v = calc(a.expression);
        return `${a.expression} = ${formatNumber(v)}`;
      }

      case 'now': {
        const off = Number.isFinite(Number(a.offset_hours)) ? Number(a.offset_hours) : 8;
        const t = fmtTime(new Date(), off);
        return `现在是 ${t.text}(${t.tz}),ISO: ${t.iso}`;
      }

      case 'draw_image': {
        if (!ctx.cfg.modelImageReady) {
          return '图像生成模型还没有配置。请管理员到面板「模型」页填写图像生成的接口地址、Key 和模型名。';
        }
        const prompt = String(a.prompt || '').trim();
        if (!prompt) return '缺少要画的描述(prompt)。';
        try {
          const r = await generateImage(ctx.cfg.models.imageGen, prompt, {
            size: a.size, timeoutMs: 60000,
          });
          ctx.media.push({ kind: 'image', bytes: r.bytes, contentType: r.contentType, prompt });
          return `图片已经生成并会随这条回复一起发出(描述:${prompt};大小 ${Math.round(r.bytes.length / 1024)}KB)。`
            + '请再用一句话向用户描述你画了什么,不要重复描述技术细节。';
        } catch (e) {
          return `图像生成失败:${e?.message || e}`;
        }
      }

      case 'create_tool': {
        // AI 自写工具:生成一条 kind='script' 的扩展,下一条消息起就能被调用。
        // 只允许管理员(由调用方在 loop 里判断 creative),避免群里任何人都会写工具。
        const name = String(a.name || '').trim();
        const code = String(a.code || '');
        if (!/^[A-Za-z0-9_-]{2,32}$/.test(name)) {
          return '工具名只能用 2-32 位字母、数字、下划线或短横线。';
        }
        if (!code.trim()) return '缺少工具代码(code)。';
        if (code.length > 20000) return '代码超过 20000 字上限。';
        let params = a.parameters;
        if (typeof params === 'string') {
          try {
            params = JSON.parse(params);
          } catch {
            return 'parameters 不是合法 JSON。';
          }
        }
        if (params && typeof params === 'object' && !params.properties) {
          return 'parameters 需要 JSON Schema 格式:{type:"object", properties:{...}, required:[...]}';
        }
        const extId = `ai_${String(a.group || 'tools').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 16)}`;
        const desc = String(a.description || 'AI 自写工具').slice(0, 300);
        try {
          await saveExt(ctx.core.env, {
            id: extId,
            kind: 'script',
            name: String(a.group_name || `AI 工具组 ${a.group || 'tools'}`).slice(0, 60),
            description: '由 AI 在对话中创建的工具组,保存后立即生效',
            enabled: true,
            config: {
              tools: [{
                name,
                description: desc,
                parameters: params && typeof params === 'object' ? params : { type: 'object', properties: {} },
                code,
                timeoutMs: Math.max(1000, Math.min(20000, Number(a.timeoutMs) || 8000)),
              }],
            },
          });
          invalidateSettings();
          return `工具已创建:x_${extId.slice(0, 10)}_${name}。`
            + '注意它要到下一条消息才能被你调用(工具清单在每轮开始时确定),'
            + '但从那之后的所有对话都能用它。'
            + `这个工具的用途:${desc}`;
        } catch (e) {
          return `创建工具失败:${e?.message || e}`;
        }
      }

      case 'list_tools': {
        const ext = await loadExts(ctx.core.env);
        const mine = ext.external.filter((e) => e.kind === 'script');
        if (!mine.length) return '还没有 AI 自写工具。';
        const rows = [];
        for (const e of mine) {
          for (const t of Array.isArray(e.config?.tools) ? e.config.tools : []) {
            rows.push(`· ${safeToolName(e.id, t.name)} — ${String(t.description || '').slice(0, 80)}`);
          }
        }
        return `已创建的 AI 工具 ${rows.length} 个(保存后即时生效):\n${rows.join('\n')}`;
      }

      case 'motd': {
        const target = parseMotdTarget(a.host || a.ip || '');
        if (target.error) return target.error;
        const port = String(a.port || target.port || '');
        const r = await queryMotd(ctx.cfg, target.host, port);
        return formatMotdText(r);
      }

      case 'web_search': {
        const t0 = Date.now();
        const out = await webSearch(ctx.cfg, String(a.query || ''), a.count);
        if (ctx.log) ctx.log(`[搜索] ${String(a.query || '').slice(0, 60)} -> ${Date.now() - t0}ms`);
        return out;
      }

      case 'group_recent':
        return await ctx.core.groupRecent(String(a.group || ''), Number(a.limit) || 20, ctx.convId);

      case 'group_find':
        return await ctx.core.groupFind(String(a.keyword || ''));

      case 'fetch_url': {
        const u = assertPublicUrl(a.url);
        const maxChars = Math.max(500, Math.min(12000, Number(a.max_chars) || 4000));
        // 配了「网页读取(/reader)」就优先走它(能处理 JS 动态渲染的站点);失败再回退直抓
        if (ctx.cfg.searchEnabled && ctx.cfg.readerApiUrl) {
          const viaApi = await readPage(ctx.cfg, u.toString(), maxChars);
          if (viaApi.text) return `来自 ${u.toString()} 的正文(经网页读取接口):\n${viaApi.text}`;
        }
        const raw = await fetchText(u.toString());
        const head = raw.trimStart();
        const text = head.startsWith('{') || head.startsWith('[')
          ? truncate(raw, maxChars)
          : htmlToText(raw, maxChars);
        const thin = text.length < 300
          ? '\n\n【注意】这个页面直接抓到的正文很少,很可能是 JavaScript 动态渲染的站点(正文要等脚本跑完才出现),或者被反爬拦住了。建议改用 web_search 搜索相关关键词(摘要里往往有内容),或换一个静态来源;如果管理员配置了「网页读取接口」,也可以用那个来读。'
          : '';
        return `来自 ${u.toString()} 的正文:\n${text}${thin}`;
      }

      case 'query_dashboard': {
        return await queryDashboard(ctx.cfg);
      }


      case 'remember': {
        const r = ctx.core.memSet(ctx.convId, a.key, a.value);
        if (r.error) return r.error;
        return `记住了:${a.key} → ${a.value}\n(以后这个会话都会带上它,回复用户时不用特意复述)`;
      }

      case 'recall': {
        const list = ctx.core.memList(ctx.convId);
        if (!list.length) return '这个会话还没有记住任何东西。';
        return ['已记住的内容:', ...list.map((m, i) => `${i + 1}. ${m.key} → ${m.value}`)].join('\n');
      }

      case 'forget': {
        const ok = ctx.core.memDel(ctx.convId, a.key);
        return ok ? `已经忘掉「${a.key}」。` : `没有找到「${a.key}」这条记忆,先用 recall 看一下有哪些。`;
      }

      case 'random':
        return doRandom(a);

      case 'encode':
        return doEncode(String(a.action || ''), a.text);

      case 'deploy_site': {
        const files = normaliseFiles(a.files, ctx.cfg);
        const wantBackend = a.enableCustomBackend === true;
        const wantPrefab = a.enablePrefabBackend === true;
        // 只有「要跑服务端代码」才需要管理员审批;纯静态网页直接部署。
        const needConfirm = (wantBackend || wantPrefab) && ctx.cfg.deployConfirm;
        if (needConfirm) {
          const pending = await ctx.core.createPendingDeploy({
            name: a.name,
            description: a.description,
            files,
            owner: ctx.convId,
            architectures: [wantBackend ? 'custom' : '', wantPrefab ? 'prefab' : ''].filter(Boolean),
          }, ctx.meta?.p);
          if (pending.error) return pending.error;
          const sent = await ctx.core.sendDeployCard(ctx.meta?.p, {
            token: pending.token,
            name: a.name,
            description: a.description,
            files,
            architectures: pending.architectures,
          }, ctx.cfg);
          const cardFail = sent?.error || '';
          const webUrl = pending.url || '';
          return [
            cardFail ? `确认卡片发送失败(${cardFail})` : '已创建待确认部署 ⏳',
            `项目名: ${a.name || '未命名项目'}`,
            `文件: ${files.map((f) => f.path).join(', ')}`,
            cardFail
              ? (webUrl
                ? `管理员可以在网页上确认:${webUrl}(10 分钟内有效)`
                : '确认卡片和网页链接都不可用,请管理员检查站点域名或稍后重试。')
              : '确认卡片已经发到群里,等待管理员点击「确认部署」或「取消」。',
            '【重要】不要自己创建项目;管理员确认后系统会继续处理,并把结果回给你。',
          ].join('\n');
        }
        const r = await ctx.core.createSite({
          name: a.name,
          description: a.description,
          files,
          owner: ctx.convId,
        });
        if (r.error) return r.error;
        return [
          '部署成功 ✅',
          `项目名: ${r.name}`,
          `链接: ${siteLink(ctx.cfg, r.url)}`,
          `ID: ${r.id}`,
          `文件: ${files.map((f) => f.path).join(', ')}`,
          `存活: 从现在起 ${r.ttlMinutes} 分钟,期间任何修改都会重新计时`,
          '【重要】请把上面这个链接原样发在回复里,并简单说明怎么玩。',
        ].join('\n');
      }

      case 'update_site': {
        const files = normaliseFiles(a.files, ctx.cfg);
        const r = await ctx.core.updateSite(String(a.id || ''), { name: a.name, files });
        if (r.error) return r.error;
        return [
          `修改成功 ✅ 链接不变: ${siteLink(ctx.cfg, r.url)}`,
          `文件: ${files.map((f) => f.path).join(', ')}`,
          `倒计时已重置为 ${r.ttlMinutes} 分钟`,
          '【重要】请把链接原样告诉用户。',
        ].join('\n');
      }

      case 'list_sites': {
        const list = await ctx.core.listSites();
        if (!list.length) {
          const expired = await ctx.core.recentExpired().catch(() => []);
          if (expired.length) {
            return '当前没有任何在线部署。\n'
              + `不过最近刚到期销毁的有 ${expired.length} 个:${expired.join('、')}。\n`
              + '每个部署默认只活一段时间(到期自动销毁),期间再修改一次就会重新计时;要长期在线需要重新部署。';
          }
          return '当前没有任何在线部署。';
        }
        return [
          `当前在线部署 ${list.length} 个:`,
          ...list.map((s, i) => `${i + 1}. ${s.name} | ID=${s.id} | ${siteLink(ctx.cfg, s.url)} | 剩余 ${s.leftSeconds} 秒 | 访问 ${s.hits} 次 | 文件 ${s.files.join(',')}`),
        ].join('\n');
      }

      case 'read_site': {
        const r = await ctx.core.getSite(String(a.id || ''));
        if (r.error) return r.error;
        if (a.path) {
          const f = r.files.find((x) => x.path === a.path);
          if (!f) return `该部署里没有 ${a.path},现有文件:${r.files.map((x) => x.path).join(', ')}`;
          return `${a.path} 的内容:\n${truncate(f.content, 12000)}`;
        }
        return [
          `${r.name}(${r.id}) ${siteLink(ctx.cfg, r.url)} · 剩余 ${r.leftSeconds} 秒`,
          '文件清单:',
          ...r.files.map((f) => `--- ${f.path} (${f.size} 字节) ---\n${truncate(f.content, 800)}`),
        ].join('\n');
      }

      case 'delete_site': {
        const ok = await ctx.core.deleteSite(String(a.id || ''));
        return ok ? `已删除部署 ${a.id},链接已失效,它的存储空间也一并释放了。` : `没找到 ID 或名称为 ${a.id} 的部署。`;
      }

      case 'fs_write': {
        const r = ctx.core.sandboxWrite(a.path, a.content);
        if (r.error) return r.error;
        return `已写入沙盒文件 ${r.path}(${r.size} 字节)。`;
      }

      case 'fs_read': {
        const r = ctx.core.sandboxRead(String(a.path || ''));
        if (r.error) return r.error;
        return `${r.path} 的内容:\n${truncate(r.content, 12000)}`;
      }

      case 'fs_list': {
        const list = ctx.core.sandboxList(String(a.path || ''));
        if (!list.length) return '沙盒是空的。用 fs_write 写点东西进去吧。';
        return ['沙盒里的文件:', ...list.map((f) => `· ${f.path} (${f.size} 字节)`)].join('\n');
      }

      case 'fs_edit': {
        const r = ctx.core.sandboxEdit(String(a.path || ''), String(a.find ?? ''), String(a.replace ?? ''));
        if (r.error) return r.error;
        return `已修改 ${r.path},现在是 ${r.size} 字节。`;
      }

      case 'fs_delete': {
        const r = ctx.core.sandboxDelete(String(a.path || ''));
        return r.error ? r.error : `已删除沙盒文件 ${a.path}。`;
      }

      case 'fs_deploy': {
        const list = ctx.core.sandboxList(String(a.dir || ''));
        const want = Array.isArray(a.paths) && a.paths.length ? a.paths.map(String) : list.map((f) => f.path);
        const files = [];
        for (const path of want) {
          const f = ctx.core.sandboxRead(path);
          if (f.error) return `沙盒里没有 ${path}`;
          files.push({ path, content: f.content });
        }
        if (!files.length) return '沙盒里没有可部署的文件,先用 fs_write 写一个 index.html。';
        const norm = normaliseFiles(files, ctx.cfg);
        const r = await ctx.core.createSite({ name: a.name, description: a.description, files: norm, owner: ctx.convId });
        if (r.error) return r.error;
        return [
          '部署成功 ✅(来自沙盒)',
          `项目名: ${r.name}`,
          `链接: ${siteLink(ctx.cfg, r.url)}`,
          `ID: ${r.id}`,
          `文件: ${norm.map((f) => f.path).join(', ')}`,
          `存活: ${r.ttlMinutes} 分钟`,
          '【重要】请把链接原样发在回复里。',
        ].join('\n');
      }

      default: {
        // 预制后端JS模块(动态工具)
        const mod = ctx.modules && ctx.modules.get ? ctx.modules.get(name) : null;
        if (mod) {
          const r = await execBackend(mod.code, {
            args: a,
            fetch: (url, init) => sandboxFetch(url, init, mod.timeoutMs || 15000),
            now: () => Date.now(),
            json: (x) => JSON.parse(String(x)),
            text: (x) => JSON.stringify(x),
          }, { timeoutMs: mod.timeoutMs || 5000 });
          if (ctx.log) ctx.log(`[模块] ${mod.name}(${name}) -> ${r.ok ? 'ok' : r.error}`);
          return moduleResultText(r);
        }
        return `没有名为 ${name} 的工具。可用工具:${TOOL_LIST}。`;
      }
    }
  } catch (e) {
    return `工具 ${name} 执行失败: ${e?.message || e}`;
  }
}

export function normaliseFiles(files, cfg) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('files 不能为空,至少要有一个 index.html');
  }
  if (files.length > 12) throw new Error('一个站点最多 12 个文件');
  const out = [];
  let total = 0;
  for (const f of files) {
    const path = String(f?.path ?? '').trim().replace(/^\.\//, '');
    if (!path) throw new Error('文件路径不能为空');
    if (path.startsWith('/') || path.includes('..') || path.includes('\\')) {
      throw new Error(`非法路径 ${path}`);
    }
    if (!/^[\w.\-\u4e00-\u9fa5]+(\/[\w.\-\u4e00-\u9fa5]+)*$/.test(path)) {
      throw new Error(`路径 ${path} 含非法字符`);
    }
    const content = String(f?.content ?? '');
    total += content.length;
    if (content.length > (cfg.maxFileBytes || 900000)) {
      throw new Error(`单个文件超过上限 ${Math.round((cfg.maxFileBytes || 900000) / 1024)} KB,请精简后再部署`);
    }
    if (total > 2 * 1024 * 1024) {
      throw new Error('代码总量超过 2 MB,请精简后再部署');
    }
    const existing = out.find((x) => x.path === path);
    if (existing) existing.content = content;
    else out.push({ path, content });
  }
  if (!out.some((f) => f.path.toLowerCase() === 'index.html')) {
    throw new Error('必须包含 index.html 作为入口页');
  }
  return out;
}
