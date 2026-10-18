// 面板开关绑定检查器。
//
// 背景(真实事故):「应急强制更新」开关渲染出来了,但 bindSettings 里只有
// upd-save 去读它的 classList,从来没有 onclick / tog() 绑定。
// 结果就是用户看到一个像开关的 div,点下去毫无反应 —— 纯图片。
// 静态自检(import 是否齐全)抓不到这类问题,必须单独扫。
//
// 判定规则:
//   渲染  = 源码里出现 sw(<表达式>,'data-t="<name>"')
//   绑定  = 存在 tog('[data-t="<name>"]') 或 querySelector('[data-t="<name>"]').onclick
// 渲染了但没绑定的,就是点不动的死开关。
import fs from 'node:fs';

const file = process.argv[2] || 'src/panel/ui.js';
const raw = fs.readFileSync(file, 'utf8');
// 源码里 data-t=\"xxx\" 的 \" 是字符串转义,还原成 " 才好匹配
const src = raw.replace(/\\"/g, '"');

const rendered = new Set();
for (const m of src.matchAll(/sw\([^,]*?,\s*'data-t="([A-Za-z0-9_]+)"'\)/g)) rendered.add(m[1]);

const bound = new Set();
for (const m of src.matchAll(/tog\('\[data-t="([A-Za-z0-9_]+)"\]'/g)) bound.add(m[1]);
// 老写法改名后的安全版(带 null 判断 + 缺节点只 warn)
for (const m of src.matchAll(/stog\('\[data-t="([A-Za-z0-9_]+)"\]'/g)) bound.add(m[1]);
// 统一绑定入口:bindTog(v,'名字',function(on){return {...}},save)
// 名字是单引号字符串字面量,直接抓第二个参数
for (const m of src.matchAll(/bindTog\(\s*[A-Za-z_$][\w$]*\s*,\s*'([A-Za-z0-9_]+)'/g)) bound.add(m[1]);
// 裸 onclick:querySelector('[data-t="x"]').onclick / var n=...; n.onclick
for (const m of src.matchAll(/querySelector\('\[data-t="([A-Za-z0-9_]+)"\]'\)\s*\.\s*onclick/g)) bound.add(m[1]);
for (const m of src.matchAll(/querySelector\('\[data-mod="([A-Za-z0-9_]+)"\]'\)/g)) bound.add(m[1]);
// 动态名批量绑定: ['a','b','c'].forEach(function(k){ querySelector('[data-t="'+k+'"]').onclick ... })
// 数组字面量在源码里很近的位置出现,这里把 forEach 回调体整段取出,收集其中的
// 数组元素,再把回调体里出现的 onclick 视为对这些元素生效。
for (const m of src.matchAll(/(\[[^\]]*?\])\s*\.forEach\(\s*function\s*\(\s*(\w+)\s*\)\s*\{([\s\S]{0,1500}?)\}\s*\)/g)) {
  const names = [...m[1].matchAll(/'([A-Za-z0-9_]+)'/g)].map((x) => x[1]);
  if (!names.length) continue;
  if (!/\.onclick|tog\(/.test(m[3])) continue;
  // 回调体里必须真的用上那个形参拼选择器,否则只是碰巧同名的数组遍历。
  // 源码里写法是 querySelector('[data-t="'+k+'"]',所以变量两边是单引号。
  const v = m[2];
  // 常见拼法: '[data-t="'+k+'"]'  /  `...${k}...`  /  'data-'+k
  const usesVar = m[3].includes("'" + v + "'")
    || m[3].includes('"' + v + '"')
    || m[3].includes("${" + v + "}")
    || m[3].includes("+" + v + "+")
    || m[3].includes("+ " + v + " +");
  if (!usesVar) continue;
  for (const n of names) bound.add(n);
}

const dead = [...rendered].filter((n) => !bound.has(n));

console.log(`渲染出的开关 ${rendered.size} 个,已绑定 ${bound.size} 个`);
if (dead.length) {
  console.log(`\n❌ 渲染了但没有点击绑定的死开关 ${dead.length} 个:`);
  for (const d of dead) console.log('   ' + d);
  process.exit(1);
}
console.log('✅ 所有渲染出的开关都有点击绑定');
