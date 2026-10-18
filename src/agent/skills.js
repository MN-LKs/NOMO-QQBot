// AI 技能:管理员上传/粘贴的技能文档,按触发词注入到 Agent 的提示词里。
// 支持 风格的前言(frontmatter):--- name: xx / description: xx ---

import { ensureSchema } from '../store/db.js';

export function parseTriggers(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map((x) => String(x).trim()).filter(Boolean);
  const s = String(raw).trim();
  if (!s) return [];
  if (s.startsWith('[')) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) return arr.map((x) => String(x).trim()).filter(Boolean);
    } catch {
      /* 不是 JSON 就按分隔符拆 */
    }
  }
  return s.split(/[,,\s]+/).map((x) => x.trim()).filter(Boolean);
}

export function normalizeSkill(r) {
  return {
    id: r.id,
    name: r.name || r.id,
    description: r.description || '',
    triggers: parseTriggers(r.triggers),
    content: r.content || '',
    enabled: !!r.enabled,
    builtin: !!r.builtin,
    updatedAt: Number(r.updated_at || 0),
  };
}

export async function listSkills(env, { enabledOnly = false } = {}) {
  await ensureSchema(env.DB);
  const rows = await env.DB.prepare('SELECT * FROM skills ORDER BY builtin DESC, name').all();
  const out = (rows.results || []).map(normalizeSkill);
  return enabledOnly ? out.filter((s) => s.enabled) : out;
}

export async function saveSkill(env, skill) {
  await ensureSchema(env.DB);
  await env.DB.prepare(
    `INSERT INTO skills (id, name, description, triggers, content, enabled, builtin, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description,
       triggers = excluded.triggers, content = excluded.content, enabled = excluded.enabled, updated_at = excluded.updated_at`,
  ).bind(
    skill.id, skill.name, skill.description, JSON.stringify(skill.triggers || []),
    skill.content, skill.enabled ? 1 : 0, skill.builtin ? 1 : 0, Date.now(),
  ).run();
  return skill;
}

export async function removeSkill(env, id) {
  await ensureSchema(env.DB);
  await env.DB.prepare('DELETE FROM skills WHERE id = ?').bind(String(id)).run();
}

// 从 SKILL.md 风格文本里拆 frontmatter
export function parseSkillDoc(text) {
  const src = String(text || '');
  const m = src.match(/^\s*---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!m) return { name: '', description: '', triggers: [], content: src.trim() };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const mm = line.match(/^\s*([A-Za-z_-]+)\s*[:：]\s*(.*)$/);
    if (mm) meta[mm[1].toLowerCase()] = mm[2].trim();
  }
  return {
    name: meta.name || '',
    description: meta.description || '',
    triggers: parseTriggers(meta.triggers || ''),
    content: src.slice(m[0].length).trim(),
  };
}

/**
 * 按用户消息挑选要注入的技能:没写触发词 = 总是带上;写了触发词 = 消息里提到才带。
 * 总量有上限,先到先得。
 */
export function pickSkills(skills, userText, maxChars = 6000) {
  const text = String(userText || '');
  const picked = [];
  let total = 0;
  for (const s of skills || []) {
    if (!s.enabled || !String(s.content || '').trim()) continue;
    const triggers = s.triggers || [];
    if (triggers.length && !triggers.some((t) => text.includes(t))) continue;
    const block = `## ${s.name}\n${s.content}`;
    if (total + block.length > maxChars) continue;
    total += block.length;
    picked.push(s);
  }
  return picked;
}
