#!/usr/bin/env node
// 提交前的强制闸门:扫全仓库,发现任何凭据/隐私信息就直接失败。
//
// 跑法:  node tools/scan-secrets.js
//        npm run check:secrets
// 退出码:0 = 干净,1 = 发现敏感内容(不要提交!)
//
// 三类检查:
//   A. 凭据特征(OpenAI/Anthropic/GitHub/AWS/Slack/私钥/JWT …)
//   B. wrangler.toml 里该留空的变量一旦非空就报错
//   C. 高危词表(真实 AppID 这类账号标识)
// 示例值/占位符可以加进 ALLOWLIST 放行。

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const SKIP_DIRS = new Set(['.git', 'node_modules', '.wrangler', '.idea', 'dist', 'coverage', '__pycache__']);
// .dev.vars 本来就该放真实值,而且已在 .gitignore 里
const SKIP_FILES = new Set(['.dev.vars', '.dev.vars.local', 'package-lock.json']);

// ---------- A. 凭据特征 ----------
const PATTERNS = [
  { name: 'OpenAI / 中转站 key', re: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { name: 'Anthropic key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'GitHub 经典 token', re: /\bghp_[A-Za-z0-9]{30,}/g },
  { name: 'GitHub 细粒度 token', re: /\bgithub_pat_[A-Za-z0-9_]{30,}/g },
  { name: 'GitHub App token', re: /\b(?:ghu|ghs)_[A-Za-z0-9]{30,}/g },
  { name: 'AWS Access Key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: '私钥文件', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
];

// ---------- B. wrangler.toml 必须留空的键 ----------
const MUST_BE_EMPTY = [
  'QQ_APP_ID', 'QQ_APP_SECRET', 'WEBHOOK_SECRET', 'ADMIN_TOKEN',
  'LLM_API_KEY', 'LLM_BASE_URL', 'DASHBOARD_URL', 'PUBLIC_BASE_URL',
];

// ---------- C. 高危词表 ----------
const ALLOWLIST = [
  'example.com', 'your-domain', '<你的域名>', 'localhost', '127.0.0.1',
  'bot.test', 'cloudflare.com', 'bot.qq.com', 'api.sgroup.qq.com', 'q.qq.com',
  '100000001',
];

const SENSITIVE_WORDS = [
  {
    // 只在「给 appId 赋值」的语境里才拦 10 位数字,避免误伤时间戳/位掩码
    name: '疑似真实 QQ 机器人 AppID',
    re: /(?:QQ_APP_ID|app_id|appId|AppID)["'\s:=]+["']?(1[0-9]{9})\b/gi,
    hint: '测试里请用 100000001 这类明显假值',
  },
];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), out);
    } else if (!SKIP_FILES.has(e.name)) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

function isBinary(buf) {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}


/** 文档里用反引号包起来的示例(以及以 - / * / # / > / | 开头的说明行)不算泄露 */
function isDocExample(text, index, len) {
  const before = text[index - 1];
  const after = text[index + len];
  if (before === '`' && after === '`') return true;
  const lineStart = text.lastIndexOf('\n', index) + 1;
  const line = text.slice(lineStart, text.indexOf('\n', index + len) === -1 ? undefined : text.indexOf('\n', index + len));
  return /^\s*(?:[-*#|>]|\/\/|\*)/.test(line);
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

function snippet(text, index, len) {
  const start = text.lastIndexOf('\n', index) + 1;
  const end = text.indexOf('\n', index + len);
  return text.slice(start, end === -1 ? undefined : end).trim().slice(0, 120);
}

const findings = [];

for (const file of walk(ROOT)) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const buf = fs.readFileSync(file);
  if (isBinary(buf)) continue;
  const text = buf.toString('utf8');

  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    let m;
    while ((m = p.re.exec(text))) {
      if (ALLOWLIST.some((a) => m[0].includes(a))) continue;
      if (isDocExample(text, m.index, m[0].length)) continue;
      findings.push({ file: rel, line: lineOf(text, m.index), kind: p.name, text: snippet(text, m.index, m[0].length) });
    }
  }

  for (const w of SENSITIVE_WORDS) {
    w.re.lastIndex = 0;
    let m;
    while ((m = w.re.exec(text))) {
      if (ALLOWLIST.some((a) => m[0].includes(a))) continue;
      const hit = snippet(text, m.index, m[0].length);
      if (/^\s*[#*]/.test(hit)) continue;
      findings.push({ file: rel, line: lineOf(text, m.index), kind: w.name, text: hit + '  (' + w.hint + ')' });
    }
  }
}

const tomlPath = path.join(ROOT, 'wrangler.toml');
if (fs.existsSync(tomlPath)) {
  const lines = fs.readFileSync(tomlPath, 'utf8').split('\n');
  let inVars = false;
  lines.forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith('[')) inVars = t === '[vars]';
    if (!inVars || t.startsWith('#')) return;
    const m = /^([A-Z0-9_]+)\s*=\s*"(.*)"\s*$/.exec(t);
    if (!m) return;
    const key = m[1];
    const value = m[2];
    if (MUST_BE_EMPTY.includes(key) && value !== '') {
      findings.push({
        file: 'wrangler.toml',
        line: i + 1,
        kind: key + ' 必须留空',
        text: key + ' = "' + value.slice(0, 6) + '…" ← 值请填在 Cloudflare 后台,不要写进仓库',
      });
    }
  });
}

if (findings.length === 0) {
  console.log('✅ 敏感信息扫描通过:没有发现凭据、密钥或私密信息。');
  process.exit(0);
}

console.error('');
console.error('❌ 发现 ' + findings.length + ' 处敏感内容,已阻止提交:');
console.error('');
for (const f of findings) {
  console.error('  ' + f.file + ':' + f.line + '  [' + f.kind + ']');
  console.error('      ' + f.text);
}
console.error('');
console.error('处理办法:');
console.error('  · 凭据/密钥 → 删掉,改到 Cloudflare Dashboard 的 Variables and Secrets');
console.error('  · 测试用的假值 → 用 test-app-secret-not-real 这类明显假的字符串');
console.error('  · 确实是示例 → 把域名或字符串加进 tools/scan-secrets.js 的 ALLOWLIST');
console.error('');
process.exit(1);
