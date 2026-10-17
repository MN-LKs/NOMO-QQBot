// 部署构建时自动清理「描述文件」(README、docs/、其它 .md),
// 让构建上下文保持干净。注意:Workers 只打包被 import 的模块,
// 这些文件本来不会进部署产物,所以这一步不会缩小 Worker 体积。
//
// 什么时候真的删:
//   1. Cloudflare 构建环境 —— Workers Builds 会注入 WORKERS_CI=1
//   2. NOMO_STRIP_DOCS=1 node tools/strip-docs.js
//   3. npm run strip:docs(等价于 --force)
// 本地 wrangler dev / deploy 只会打印一行提示,不会动你的文档。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SKIP_DIRS = new Set(['node_modules', '.git', '.wrangler', '.backups', '.github']);
const DOC_DIRS = ['docs'];
const DOC_RE = /\.(md|markdown|mdx)$/i;

export function collectDocTargets(root = process.cwd()) {
  const dirs = [];
  for (const name of DOC_DIRS) {
    const p = path.join(root, name);
    try {
      if (fs.statSync(p).isDirectory()) dirs.push(p);
    } catch {
      /* 没有这个目录 */
    }
  }
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(p);
      } else if (DOC_RE.test(e.name)) {
        files.push(p);
      }
    }
  };
  walk(root);
  const kept = files.filter((f) => !dirs.some((d) => f.startsWith(d + path.sep)));
  return { files: kept, dirs };
}

export function stripDocs(root = process.cwd(), { force = false } = {}) {
  const { files, dirs } = collectDocTargets(root);
  if (!force) return { skipped: true, removed: [], files, dirs };
  const removed = [];
  for (const f of files) {
    try {
      fs.rmSync(f, { force: true });
      removed.push(path.relative(root, f));
    } catch {
      /* 删不掉就算了,不影响部署 */
    }
  }
  for (const d of dirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
      removed.push(path.relative(root, d) + '/');
    } catch {
      /* 同上 */
    }
  }
  return { skipped: false, removed, files, dirs };
}

function main() {
  const force = process.argv.includes('--force') || process.env.NOMO_STRIP_DOCS === '1';
  const inCi = !!process.env.WORKERS_CI;
  const { files, dirs } = collectDocTargets();
  const count = files.length + dirs.length;
  if (!force && !inCi) {
    console.log(`[strip-docs] 本地环境,跳过(检测到 ${count} 个描述文件/目录;要真的清理用 npm run strip:docs)`);
    return;
  }
  const r = stripDocs(process.cwd(), { force: true });
  if (!r.removed.length) {
    console.log('[strip-docs] 没有需要清理的描述文件');
    return;
  }
  console.log(`[strip-docs] 已清理 ${r.removed.length} 个描述文件/目录:`);
  for (const x of r.removed) console.log(`  - ${x}`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    main();
  } catch (e) {
    console.warn('[strip-docs] 清理时出错(不影响部署):', e && e.message ? e.message : e);
  }
}
