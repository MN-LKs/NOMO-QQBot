import { runProgram, formatValue } from '/workspace/QQ/src/core/jsmini-run.js';

let pass = 0, fail = 0;
async function t(name, code, expect, opts = {}) {
  try {
    const { value } = await runProgram(code, opts);
    const got = formatValue(value);
    if (got === String(expect)) { pass++; console.log(`✓ ${name}`); }
    else { fail++; console.log(`✗ ${name} — 期望 ${JSON.stringify(expect)}, 实际 ${JSON.stringify(got)}`); }
  } catch (e) {
    fail++; console.log(`✗ ${name} — 抛错: ${e.message}`);
  }
}
async function terr(name, code, msgPart, opts = {}) {
  try {
    await runProgram(code, opts);
    fail++; console.log(`✗ ${name} — 应该抛错但没抛`);
  } catch (e) {
    if (String(e.message).includes(msgPart)) { pass++; console.log(`✓ ${name}`); }
    else { fail++; console.log(`✗ ${name} — 错误信息不对: ${e.message}`); }
  }
}

await t('算术', 'return 1 + 2 * 3', 7);
await t('括号优先级', 'return (1 + 2) * 3', 9);
await t('字符串拼接', "return 'a' + 'b' + 1", 'ab1');
await t('模板字符串', 'let n = 5; return `共 ${n} 个, ${n*2} 倍`', '共 5 个, 10 倍');
await t('变量与常量', 'let a = 1; const b = 2; a = a + b; return a', 3);
await terr('常量不可改', 'const a = 1; a = 2; return a', '常量');
await t('函数', 'function add(a, b) { return a + b; } return add(2, 3)', 5);
await t('函数提升', 'return mul(3, 4); function mul(a, b) { return a * b; }', 12);
await t('箭头函数', 'const f = (x) => x * 2; return f(21)', 42);
await t('箭头单参无括号', 'const f = x => x + 1; return f(1)', 2);
await t('箭头块体', 'const f = (x) => { let y = x * 2; return y; }; return f(5)', 10);
await t('递归', 'function fib(n) { return n <= 1 ? n : fib(n-1) + fib(n-2); } return fib(10)', 55);
await t('for 循环', 'let s = 0; for (let i = 1; i <= 10; i++) { s += i; } return s', 55);
await t('for 多变量', 'let s = 0; for (let i = 0, j = 10; i < j; i++, j--) { s++; } return s', 5);
await t('while + break', 'let i = 0; while (true) { i++; if (i >= 5) break; } return i', 5);
await t('continue', 'let s = 0; for (let i = 0; i < 10; i++) { if (i % 2) continue; s += i; } return s', 20);
await t('for-of', 'let s = 0; for (const x of [1,2,3,4]) { s += x; } return s', 10);
await t('for-of 字符串', 'let out = ""; for (const c of "abc") { out = out + c + "-"; } return out', 'a-b-c-');
await t('数组方法', 'const a = [1,2,3,4,5]; return a.filter(x => x % 2).map(x => x * 10).join(",")', '10,30,50');
await t('reduce', 'return [1,2,3,4].reduce((s, x) => s + x, 100)', 110);
await t('find', 'return [5, 10, 15].find(x => x > 7)', 10);
await t('数组 push/pop', 'const a = []; a.push(1); a.push(2); return a.pop() + a.length', 3);
await t('字符串方法', 'return "Hello World".toLowerCase().split(" ").join("_")', 'hello_world');
await t('字符串 slice', 'return "abcdef".slice(1, 3)', 'bc');
await t('字符串 replace', 'return "a-b-c".replace("-", "+")', 'a+b-c');
await t('padStart', 'return String(7).padStart(3, "0")', '007');
await t('对象', 'const o = {a: 1, b: 2}; o.c = 3; return o.a + o.b + o.c', 6);
await t('对象方法', 'const o = {x: 9}; return Object.keys(o).join() + Object.values(o).join()', 'x9');
await t('嵌套对象', 'const o = {a: {b: {c: 42}}}; return o.a.b.c', 42);
await t('可选链', 'const o = null; return o?.a?.b ?? "默认"', '默认');
await t('?? 运算符', 'return null ?? "x"', 'x');
await t('三元', 'return 1 > 2 ? "a" : "b"', 'b');
await t('typeof', 'return typeof "s" + typeof 1 + typeof true + typeof undefined', 'stringnumberbooleanundefined');
await t('typeof 未定义变量', 'return typeof notDefined', 'undefined');
await t('逻辑运算返回操作数', 'return (0 || "a") + ("" || "b")', 'ab');
await t('比较', 'return [1 === 1, 1 == "1", null == undefined, 1 !== 2].join(",")', 'true,true,true,true');
await t('Math', 'return Math.floor(3.7) + Math.max(1, 9) + Math.abs(-2)', 14);
await t('JSON', 'const o = JSON.parse("{\\"a\\": [1,2]}"); return JSON.stringify(o.a)', '[1,2]');
await t('try/catch', 'try { throw new Error("boom"); } catch (e) { return "caught:" + e.message; }', 'caught:boom');
await t('try/catch 非Error', 'try { throw "raw"; } catch (e) { return "got " + e; }', 'got raw');
await terr('解构不支持(明确报错)', 'const [a, b] = [1, 2]; return a + b', '变量名');
await t('嵌套函数闭包', 'function outer() { let x = 1; function inner() { x++; return x; } inner(); inner(); return x; } return outer()', 3);
await t('异步 host 函数', 'const r = await ctx.fetch("u"); return "got:" + r', 'got:OK', { globals: { ctx: { fetch: async () => 'OK' } } });
await t('无 await 的异步调用也等', 'const r = ctx.add(1, 2); return r * 10', 30, { globals: { ctx: { add: async (a, b) => a + b } } });
await t('console.log 收集', 'console.log("hi", 1); return "done"', 'done');
await t('对象返回', 'return {ok: true, n: 1}', '{\n  "ok": true,\n  "n": 1\n}');
await t('自增自减', 'let i = 5; const a = i++; const b = ++i; return [a, b, i].join()', '5,7,7');
await t('复合赋值', 'let x = 10; x *= 2; x -= 5; return x', 15);
await t('位运算', 'return (6 & 3) + (6 | 3) + (1 << 4)', 25);
await t('字符串转数字', 'return "5" * "4" + parseInt("10px")', 30);
await t('sort', 'const a = [3, 1, 2]; a.sort((x, y) => x - y); return a.join()', '1,2,3');
await t('sort 默认', 'return ["b","a","c"].sort().join()', 'a,b,c');
await t('嵌套模板', 'const n = 2; return `${n} + ${`${n}`} = ${n + n}`', '2 + 2 = 4');
await t('await 顶层', 'const v = await ctx.slow(); return v', 'slow-ok', { globals: { ctx: { slow: async () => 'slow-ok' } } });

await terr('死循环被步数挡住', 'while (true) {}', '步数', { maxSteps: 5000 });
await terr('语法错误提示', 'let = 1', '语法错误');
await terr('不支持 class', 'class A {}', '不支持');
await terr('不支持 new', 'const d = new Date(); return d', '不支持');
await terr('超时', 'while (true) { }', '步数', { maxSteps: 3000, timeoutMs: 100 });

console.log(`\n===== 通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
