// 静态自检:在跑测试之前先把「代码层面一定会炸」的问题找出来。
// 覆盖:
//   1. 所有 .js 的语法(node --check)
//   2. 所有相对 import / export / 动态 import 是否能解析到真实文件
//   3. package.json 脚本里引用的本地文件是否存在
//   4. wrangler.toml 的 main 是否存在
//   5. Markdown 里的相对链接是否指向真实文件
//   6. 关键文档是否齐全
//
// 只读,不改任何文件。发现问题时退出码为 1。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['node_modules', '.git', '.wrangler', '.backups', '.idea', '__pycache__']);
const CHECK_DIRS = ['src', 'test', 'tools'];
const REQUIRED_DOCS = [
  'README.md',
  'docs/QUICKSTART.md',
  'docs/FAQ.md',
  'docs/DEPLOY.md',
  'docs/ARCHITECTURE.md',
  'docs/COMMANDS.md',
  'docs/LIMITS.md',
  'docs/SECURITY.md',
  'docs/FEATURES.md',
];

const errors = [];
const warnings = [];
let jsCount = 0;
let importCount = 0;
let linkCount = 0;

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(p, out);
    } else if (e.isFile()) {
      out.push(p);
    }
  }
  return out;
}

function rel(p) {
  return path.relative(ROOT, p).replace(/\\/g, '/');
}

function existsFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// ---------- 1. 语法 ----------
function checkSyntax(file) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) {
    const msg = String(r.stderr || '').split('\n').filter(Boolean).slice(0, 4).join(' | ');
    errors.push(`语法错误 ${rel(file)}: ${msg}`);
  }
}

// ---------- 2. import 解析 ----------
const IMPORT_RE = /(?:^|[^\w$])(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"](\.[^'"]+)['"]/g;
const DYNAMIC_RE = /\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g;

// 本机绝对路径在 GitHub Actions / Cloudflare 构建里一定不存在。
// 只检查引号里的路径,避免把普通 URL 里的 /home/ 误判。
const ABS_PATH_PATTERNS = [
  /(['"`])\/workspace\//,
  /(['"`])\/home\/[A-Za-z0-9._-]+\//,
  /(['"`])\/Users\/[A-Za-z0-9._-]+\//,
  /(['"`])[A-Za-z]:\\Users\\/,
];

function checkAbsolutePaths(file, code) {
  for (const re of ABS_PATH_PATTERNS) {
    const m = code.match(re);
    if (m) errors.push(`硬编码绝对路径 ${rel(file)}: ${m[0]}…(换成本文件相对路径)`);
  }
}

function resolveSpecifier(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [base, `${base}.js`, `${base}.mjs`, `${base}.json`, path.join(base, 'index.js')];
  return candidates.find(existsFile) || '';
}

function checkImports(file, code) {
  const specs = new Set();
  for (const re of [IMPORT_RE, DYNAMIC_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(code))) specs.add(m[1]);
  }
  for (const spec of specs) {
    importCount++;
    if (!resolveSpecifier(file, spec)) {
      errors.push(`import 找不到目标 ${rel(file)} -> ${spec}`);
    }
  }
}

// ---------- 3. package.json 脚本 ----------
function checkScripts() {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  } catch (e) {
    errors.push(`package.json 读不了: ${e.message}`);
    return;
  }
  for (const [name, cmd] of Object.entries(pkg.scripts || {})) {
    const m = String(cmd).match(/\bnode\s+([^\s&|;]+)/);
    if (!m || m[1].startsWith('-')) continue;
    if (!existsFile(path.resolve(ROOT, m[1]))) {
      errors.push(`npm run ${name} 引用的文件不存在: ${m[1]}`);
    }
  }
}

// ---------- 4. wrangler main ----------
function checkWrangler() {
  let text = '';
  try {
    text = fs.readFileSync(path.join(ROOT, 'wrangler.toml'), 'utf8');
  } catch {
    warnings.push('没有找到 wrangler.toml');
    return;
  }
  const m = text.match(/^\s*main\s*=\s*["']([^"']+)["']/m);
  if (!m) {
    warnings.push('wrangler.toml 里没有 main');
    return;
  }
  if (!existsFile(path.resolve(ROOT, m[1]))) {
    errors.push(`wrangler.toml 的 main 不存在: ${m[1]}`);
  }
}

// ---------- 5. Markdown 相对链接 ----------
const LINK_RE = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

function checkMarkdownLinks(file, text) {
  let m;
  LINK_RE.lastIndex = 0;
  while ((m = LINK_RE.exec(text))) {
    let target = m[1].replace(/^<|>$/g, '');
    if (!target || /^(?:https?:|mailto:|tel:|data:|#)/i.test(target)) continue;
    target = target.split('#')[0].split('?')[0];
    if (!target) continue;
    linkCount++;
    const p = path.resolve(path.dirname(file), decodeURIComponent(target));
    if (!fs.existsSync(p)) {
      errors.push(`文档链接失效 ${rel(file)} -> ${target}`);
    }
  }
}

// ---------- 6. 关键文档 ----------
function checkDocs() {
  for (const d of REQUIRED_DOCS) {
    if (!existsFile(path.join(ROOT, d))) errors.push(`缺少关键文档: ${d}`);
  }
}

// ---------- 执行 ----------
const files = [];
for (const d of CHECK_DIRS) {
  const dir = path.join(ROOT, d);
  if (fs.existsSync(dir)) files.push(...walk(dir));
}
for (const f of files) {
  if (!/\.(?:js|mjs)$/i.test(f)) continue;
  jsCount++;
  checkSyntax(f);
  const code = fs.readFileSync(f, 'utf8');
  checkAbsolutePaths(f, code);
  checkImports(f, code);
}

for (const f of walk(ROOT)) {
  if (!/\.md$/i.test(f)) continue;
  checkMarkdownLinks(f, fs.readFileSync(f, 'utf8'));
}

checkScripts();
checkWrangler();
checkDocs();

console.log(`[audit] 检查 ${jsCount} 个 JS、${importCount} 条 import、${linkCount} 条文档链接`);
if (warnings.length) {
  for (const w of warnings) console.log(`  ! ${w}`);
}
if (errors.length) {
  console.log(`❌ 发现 ${errors.length} 个问题:`);
  for (const e of errors) console.log(`  - ${e}`);
  process.exit(1);
}
console.log('✅ 静态自检通过');
