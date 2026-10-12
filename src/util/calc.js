// 安全计算器。Workers 里不能用 eval/new Function,所以自己写一个递归下降解析器。
// 支持 + - * / % ^ ( ),一元正负,以及少量函数与常量。

const FUNCS = {
  abs: Math.abs, sqrt: Math.sqrt, cbrt: Math.cbrt, round: Math.round,
  floor: Math.floor, ceil: Math.ceil, sign: Math.sign, exp: Math.exp,
  log: Math.log, log2: Math.log2, log10: Math.log10,
  sin: Math.sin, cos: Math.cos, tan: Math.tan, atan: Math.atan,
  pow: Math.pow, min: Math.min, max: Math.max, hypot: Math.hypot,
};

const CONSTS = { pi: Math.PI, e: Math.E, tau: Math.PI * 2 };

export function calc(expr) {
  const src = String(expr ?? '');
  let i = 0;

  const ws = () => {
    while (i < src.length && /\s/.test(src[i])) i++;
  };
  const peek = () => {
    ws();
    return src[i];
  };
  const eat = (ch) => {
    ws();
    if (src[i] !== ch) throw new Error(`第 ${i} 个字符处期望 "${ch}"`);
    i++;
  };

  function parseExpr() {
    let v = parseTerm();
    for (;;) {
      const c = peek();
      if (c === '+' || c === '-') {
        i++;
        const r = parseTerm();
        v = c === '+' ? v + r : v - r;
      } else if (c === '×' || c === '*') {
        i++;
        v *= parseTerm();
      } else if (c === '÷') {
        i++;
        v /= parseTerm();
      } else return v;
    }
  }

  function parseTerm() {
    let v = parseUnary();
    for (;;) {
      const c = peek();
      if (c === '*' || c === '×') {
        i++;
        v *= parseUnary();
      } else if (c === '/' || c === '÷') {
        i++;
        v /= parseUnary();
      } else if (c === '%') {
        i++;
        v %= parseUnary();
      } else return v;
    }
  }

  function parseUnary() {
    const c = peek();
    if (c === '-') {
      i++;
      return -parseUnary();
    }
    if (c === '+') {
      i++;
      return parseUnary();
    }
    return parsePower();
  }

  function parsePower() {
    const base = parseAtom();
    if (peek() === '^' || (src[i] === '*' && src[i + 1] === '*')) {
      i += src[i] === '^' ? 1 : 2;
      return Math.pow(base, parseUnary());
    }
    return base;
  }

  function parseAtom() {
    ws();
    const c = src[i];
    if (c === '(') {
      i++;
      const v = parseExpr();
      eat(')');
      return v;
    }
    if (/[0-9.]/.test(c || '')) {
      const m = /^[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?/.exec(src.slice(i));
      if (!m) throw new Error('数字解析失败');
      i += m[0].length;
      return parseFloat(m[0]);
    }
    if (/[A-Za-z_]/.test(c || '')) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
      const name = m[0].toLowerCase();
      i += m[0].length;
      ws();
      if (src[i] === '(') {
        i++;
        const args = [];
        ws();
        if (src[i] !== ')') {
          args.push(parseExpr());
          while (peek() === ',') {
            i++;
            args.push(parseExpr());
          }
        }
        eat(')');
        const fn = FUNCS[name];
        if (!fn) throw new Error(`未知函数 ${name}`);
        return fn(...args);
      }
      if (name in CONSTS) return CONSTS[name];
      throw new Error(`未知标识符 ${name}`);
    }
    throw new Error(`第 ${i} 个字符处无法解析: ${JSON.stringify(src.slice(i, i + 10))}`);
  }

  const out = parseExpr();
  ws();
  if (i !== src.length) throw new Error(`表达式末尾有多余内容: ${JSON.stringify(src.slice(i, i + 20))}`);
  if (!Number.isFinite(out)) throw new Error('计算结果不是有限数');
  return out;
}

/** 给模型看的漂亮结果:整数就不带小数点 */
export function formatNumber(n) {
  if (Number.isInteger(n)) return String(n);
  const r = Math.round(n * 1e12) / 1e12;
  return String(r);
}
