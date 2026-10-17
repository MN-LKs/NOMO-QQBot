// 迷你 JS 解释器。
//
// 为什么需要它:Cloudflare Workers 出于安全考虑禁用了 eval() / new Function(),
// 而「预制后端JS」和「站点后端(后端JS编写)」都需要在服务里跑动态代码,
// 所以这里用纯 JS 写了一个支持常用语法子集的解释器,零依赖、可在任意环境运行,
// 而且可以精确控制步数和超时,天然就是沙盒。
//
// 支持:let/const/var、if/else、for、for-of、while、break/continue、函数(含箭头)、
//       模板字符串、对象/数组字面量、成员/下标访问、try/catch/throw、await、typeof、
//       三元、逗号、常用运算符、Math/JSON/字符串/数组/数字 常用方法。
// 不支持:import/export、class、new、switch、解构、展开、生成器、this。

const PUNCT = [
  '>>>=', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=',
  '...', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--',
  '+=', '-=', '*=', '/=', '%=', '**', '<<', '>>',
  '+', '-', '*', '/', '%', '=', '<', '>', '!', '?', ':', '.', ',', ';',
  '(', ')', '[', ']', '{', '}', '&', '|', '^', '~',
].sort((a, b) => b.length - a.length);

const KEYWORDS = new Set([
  'let', 'const', 'var', 'if', 'else', 'for', 'while', 'function', 'return',
  'break', 'continue', 'true', 'false', 'null', 'undefined', 'typeof', 'of',
  'try', 'catch', 'finally', 'throw', 'async', 'await', 'void',
  'class', 'new', 'switch', 'case', 'default', 'delete', 'instanceof',
  'import', 'export', 'yield', 'super', 'this', 'do', 'in',
]);

const IDENT_START = /[A-Za-z_$\u4e00-\u9fff]/;
const IDENT_PART = /[A-Za-z0-9_$\u4e00-\u9fff]/;

export function tokenize(src) {
  const toks = [];
  let i = 0;
  const n = src.length;
  const push = (type, value, pos) => toks.push({ type, value, pos });

  while (i < n) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i++;
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      i += 2;
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      const start = i;
      if (ch === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X')) {
        i += 2;
        while (i < n && /[0-9a-fA-F]/.test(src[i])) i++;
        push('num', parseInt(src.slice(start + 2, i), 16), start);
        continue;
      }
      while (i < n && /[0-9]/.test(src[i])) i++;
      if (src[i] === '.') {
        i++;
        while (i < n && /[0-9]/.test(src[i])) i++;
      }
      if (src[i] === 'e' || src[i] === 'E') {
        let j = i + 1;
        if (src[j] === '+' || src[j] === '-') j++;
        if (/[0-9]/.test(src[j] || '')) {
          i = j;
          while (i < n && /[0-9]/.test(src[i])) i++;
        }
      }
      const num = Number(src.slice(start, i));
      if (Number.isNaN(num)) throw syntaxErr(`数字写错了:${src.slice(start, i)}`, start);
      push('num', num, start);
      continue;
    }
    if (ch === '"' || ch === "'") {
      const start = i;
      i++;
      let out = '';
      let closed = false;
      while (i < n) {
        const c = src[i];
        if (c === '\\') {
          const esc = src[i + 1];
          i += 2;
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === 'b') out += '\b';
          else if (esc === 'f') out += '\f';
          else if (esc === 'v') out += '\v';
          else if (esc === '0') out += '\0';
          else if (esc === 'u') {
            const hex = src.slice(i, i + 4);
            if (/^[0-9a-fA-F]{4}$/.test(hex)) {
              out += String.fromCharCode(parseInt(hex, 16));
              i += 4;
            } else out += 'u';
          } else if (esc === 'x') {
            const hex = src.slice(i, i + 2);
            if (/^[0-9a-fA-F]{2}$/.test(hex)) {
              out += String.fromCharCode(parseInt(hex, 16));
              i += 2;
            } else out += 'x';
          } else out += esc === undefined ? '' : esc;
          continue;
        }
        if (c === ch) {
          closed = true;
          i++;
          break;
        }
        if (c === '\n') break;
        out += c;
        i++;
      }
      if (!closed) throw syntaxErr('字符串没有收尾的引号', start);
      push('str', out, start);
      continue;
    }
    if (ch === '`') {
      const start = i;
      const { parts, next } = scanTemplate(src, i);
      i = next;
      push('tpl', parts, start);
      continue;
    }
    if (IDENT_START.test(ch)) {
      const start = i;
      while (i < n && IDENT_PART.test(src[i])) i++;
      const word = src.slice(start, i);
      push(KEYWORDS.has(word) ? 'kw' : 'ident', word, start);
      continue;
    }
    let matched = '';
    for (const p of PUNCT) {
      if (src.startsWith(p, i)) {
        matched = p;
        break;
      }
    }
    if (matched) {
      push('punc', matched, i);
      i += matched.length;
      continue;
    }
    throw syntaxErr(`不认识的字符 ${JSON.stringify(ch)}`, i);
  }
  push('eof', '', n);
  return toks;
}

// 扫描模板字符串:返回 [{str}, {exprSrc}, {str}...] 和下一个位置
function scanTemplate(src, start) {
  const n = src.length;
  let i = start + 1;
  const parts = [];
  let buf = '';
  const flushStr = () => {
    parts.push({ str: buf });
    buf = '';
  };
  while (i < n) {
    const c = src[i];
    if (c === '\\') {
      const esc = src[i + 1];
      i += 2;
      if (esc === 'n') buf += '\n';
      else if (esc === 't') buf += '\t';
      else if (esc === 'r') buf += '\r';
      else if (esc === '`') buf += '`';
      else if (esc === '$') buf += '$';
      else if (esc === '\\') buf += '\\';
      else if (esc === 'u') {
        const hex = src.slice(i, i + 4);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          buf += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else buf += 'u';
      } else buf += esc === undefined ? '' : esc;
      continue;
    }
    if (c === '`') {
      flushStr();
      return { parts, next: i + 1 };
    }
    if (c === '$' && src[i + 1] === '{') {
      flushStr();
      const { exprSrc, next } = scanTemplateExpr(src, i + 2, start);
      parts.push({ exprSrc });
      i = next;
      continue;
    }
    buf += c;
    i++;
  }
  throw syntaxErr('模板字符串没有收尾的反引号', start);
}

function scanTemplateExpr(src, from, tplStart) {
  const n = src.length;
  let i = from;
  let depth = 1;
  let out = '';
  while (i < n) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return { exprSrc: out, next: i + 1 };
    } else if (c === '"' || c === "'") {
      const q = c;
      out += c;
      i++;
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') {
          out += src[i];
          i++;
        }
        if (i < n) {
          out += src[i];
          i++;
        }
      }
      out += q;
      i++;
      continue;
    } else if (c === '`') {
      const { parts, next } = scanTemplate(src, i);
      out += src.slice(i, next);
      i = next;
      continue;
    }
    out += c;
    i++;
  }
  throw syntaxErr('模板字符串里的 ${ 没有收尾的 }', tplStart);
}

function syntaxErr(msg, pos) {
  return new Error(`语法错误(第 ${pos} 字符):${msg}`);
}

// ---------------------------------------------------------------------------
// 语法分析:递归下降 + 优先级爬升
// ---------------------------------------------------------------------------

export function parse(src) {
  const toks = tokenize(src);
  let i = 0;
  const peek = (k = 0) => toks[i + k];
  const next = () => toks[i++];
  const at = (v) => peek().value === v && (peek().type === 'punc' || peek().type === 'kw');
  const eat = (v) => {
    if (at(v)) {
      i++;
      return true;
    }
    return false;
  };
  const expect = (v) => {
    if (!eat(v)) throw syntaxErr(`这里应该是 ${v},实际是 ${JSON.stringify(peek().value) || '结尾'}`, peek().pos);
  };

  const unsupported = () => {
    const t = peek();
    if (t.type === 'kw') {
      const bad = ['class', 'switch', 'case', 'default', 'import', 'export', 'yield', 'super', 'this', 'do', 'in'];
      if (bad.includes(t.value)) {
        throw syntaxErr(`沙盒JS不支持 ${t.value}(可用:let/const/var、if、for、while、函数、箭头函数、模板字符串、try/catch)`, t.pos);
      }
    }
  };

  function parseProgram() {
    const body = [];
    while (peek().type !== 'eof') body.push(parseStatement());
    return { type: 'Program', body };
  }

  function parseStatement() {
    unsupported();
    const t = peek();
    if (t.type === 'punc' && t.value === ';') {
      next();
      return { type: 'Empty' };
    }
    if (t.type === 'punc' && t.value === '{') return parseBlock();
    if (t.type === 'kw') {
      switch (t.value) {
        case 'let':
        case 'const':
        case 'var':
          return parseVarDecl();
        case 'if':
          return parseIf();
        case 'for':
          return parseFor();
        case 'while':
          return parseWhile();
        case 'function':
          return parseFunctionDecl();
        case 'async':
          if (peek(1).value === 'function') {
            next();
            return parseFunctionDecl(true);
          }
          break;
        case 'return': {
          next();
          const arg = at(';') || at('}') || peek().type === 'eof' ? null : parseExpression();
          eat(';');
          return { type: 'Return', arg };
        }
        case 'break':
          next();
          eat(';');
          return { type: 'Break' };
        case 'continue':
          next();
          eat(';');
          return { type: 'Continue' };
        case 'try':
          return parseTry();
        case 'throw': {
          next();
          const arg = parseExpression();
          eat(';');
          return { type: 'Throw', arg };
        }
        default:
          break;
      }
    }
    const expr = parseExpression();
    eat(';');
    return { type: 'ExprStmt', expr };
  }

  function parseBlock() {
    expect('{');
    const body = [];
    while (!at('}')) {
      if (peek().type === 'eof') throw syntaxErr('代码块没有收尾的 }', peek().pos);
      body.push(parseStatement());
    }
    expect('}');
    return { type: 'Block', body };
  }

  function parseVarDecl() {
    const kind = next().value;
    const decls = [];
    for (;;) {
      const nameTok = next();
      if (nameTok.type !== 'ident') throw syntaxErr('变量名不合法', nameTok.pos);
      if (at('=')) {
        next();
        decls.push({ name: nameTok.value, init: parseAssignment() });
      } else {
        decls.push({ name: nameTok.value, init: null });
      }
      if (!eat(',')) break;
    }
    eat(';');
    return { type: 'VarDecl', kind, decls };
  }

  function parseIf() {
    expect('if');
    expect('(');
    const test = parseExpression();
    expect(')');
    const cons = parseStatement();
    let alt = null;
    if (eat('else')) alt = parseStatement();
    return { type: 'If', test, cons, alt };
  }

  function parseWhile() {
    expect('while');
    expect('(');
    const test = parseExpression();
    expect(')');
    const body = parseStatement();
    return { type: 'While', test, body };
  }

  function parseFor() {
    expect('for');
    expect('(');
    // for-of 探测:let/const/var name of / ident of
    const save = i;
    let kind = null;
    let name = null;
    if (at('let') || at('const') || at('var')) {
      kind = next().value;
      const idTok = next();
      if (idTok.type === 'ident' && at('of')) {
        name = idTok.value;
        next();
        const iterable = parseExpression();
        expect(')');
        const body = parseStatement();
        return { type: 'ForOf', kind, name, iterable, body };
      }
      i = save;
    } else {
      const idTok = next();
      if (idTok.type === 'ident' && at('of')) {
        name = idTok.value;
        next();
        const iterable = parseExpression();
        expect(')');
        const body = parseStatement();
        return { type: 'ForOf', kind: null, name, iterable, body };
      }
      i = save;
    }
    let init = null;
    if (!at(';')) {
      if (at('let') || at('const') || at('var')) init = parseVarDeclNoSemi();
      else init = { type: 'ExprStmt', expr: parseExpression() };
    }
    expect(';');
    let test = null;
    if (!at(';')) test = parseExpression();
    expect(';');
    let update = null;
    if (!at(')')) update = parseExpression();
    expect(')');
    const body = parseStatement();
    return { type: 'For', init, test, update, body };
  }

  function parseVarDeclNoSemi() {
    const kind = next().value;
    const decls = [];
    for (;;) {
      const nameTok = next();
      if (nameTok.type !== 'ident') throw syntaxErr('变量名不合法', nameTok.pos);
      if (at('=')) {
        next();
        decls.push({ name: nameTok.value, init: parseAssignment() });
      } else {
        decls.push({ name: nameTok.value, init: null });
      }
      if (!eat(',')) break;
    }
    return { type: 'VarDecl', kind, decls };
  }

  function parseFunctionDecl(isAsync = false) {
    expect('function');
    const nameTok = next();
    if (nameTok.type !== 'ident') throw syntaxErr('函数名不合法', nameTok.pos);
    const params = parseParams();
    const body = parseBlock();
    return { type: 'FuncDecl', name: nameTok.value, params, body, async: isAsync };
  }

  function parseParams() {
    expect('(');
    const params = [];
    while (!at(')')) {
      const t = next();
      if (t.type !== 'ident') throw syntaxErr('参数名不合法(沙盒JS不支持解构/默认值)', t.pos);
      params.push(t.value);
      if (!eat(',')) break;
    }
    expect(')');
    return params;
  }

  function parseTry() {
    expect('try');
    const block = parseBlock();
    let catchParam = null;
    let catchBody = null;
    let finallyBody = null;
    if (eat('catch')) {
      if (eat('(')) {
        const t = next();
        if (t.type !== 'ident') throw syntaxErr('catch 的参数名不合法', t.pos);
        catchParam = t.value;
        expect(')');
      }
      catchBody = parseBlock();
    }
    if (eat('finally')) finallyBody = parseBlock();
    if (!catchBody && !finallyBody) throw syntaxErr('try 后面要有 catch 或 finally', peek().pos);
    return { type: 'Try', block, catchParam, catchBody, finallyBody };
  }

  // ---------- 表达式 ----------

  function parseExpression() {
    let expr = parseAssignment();
    while (at(',')) {
      next();
      expr = { type: 'Sequence', left: expr, right: parseAssignment() };
    }
    return expr;
  }

  const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '**=']);

  function parseAssignment() {
    const left = parseConditional();
    const t = peek();
    if (t.type === 'punc' && ASSIGN_OPS.has(t.value)) {
      if (left.type !== 'Ident' && left.type !== 'Member') {
        throw syntaxErr('赋值的左边必须是变量或属性', t.pos);
      }
      next();
      const value = parseAssignment();
      return { type: 'Assign', op: t.value, target: left, value };
    }
    return left;
  }

  function parseConditional() {
    const test = parseNullish();
    if (at('?')) {
      next();
      const cons = parseAssignment();
      expect(':');
      const alt = parseAssignment();
      return { type: 'Ternary', test, cons, alt };
    }
    return test;
  }

  const binLevels = [
    ['??'],
    ['||'],
    ['&&'],
    ['|'],
    ['^'],
    ['&'],
    ['==', '===', '!='],
    ['!==', '<', '>', '<=', '>='],
    ['<<', '>>'],
    ['+', '-'],
    ['*', '/', '%'],
  ];

  function parseBinary(level) {
    if (level >= binLevels.length) return parseExponent();
    let left = parseBinary(level + 1);
    const ops = binLevels[level];
    while (peek().type === 'punc' && ops.includes(peek().value)) {
      const op = next().value;
      const right = parseBinary(level + 1);
      left = op === '&&' || op === '||' || op === '??'
        ? { type: 'Logical', op, left, right }
        : { type: 'Binary', op, left, right };
    }
    return left;
  }

  function parseNullish() {
    return parseBinary(0);
  }

  function parseExponent() {
    const left = parseUnary();
    if (at('**')) {
      next();
      const right = parseExponent();
      return { type: 'Binary', op: '**', left, right };
    }
    return left;
  }

  function parseUnary() {
    const t = peek();
    if (t.type === 'punc' && ['!', '-', '+', '~', '++', '--'].includes(t.value)) {
      next();
      const arg = parseUnary();
      if (t.value === '++' || t.value === '--') {
        if (arg.type !== 'Ident' && arg.type !== 'Member') throw syntaxErr(`${t.value} 的对象必须是变量或属性`, t.pos);
        return { type: 'Update', op: t.value, target: arg, prefix: true };
      }
      return { type: 'Unary', op: t.value, arg };
    }
    if (t.type === 'kw') {
      if (t.value === 'typeof') {
        next();
        return { type: 'Unary', op: 'typeof', arg: parseUnary() };
      }
      if (t.value === 'void') {
        next();
        return { type: 'Unary', op: 'void', arg: parseUnary() };
      }
      if (t.value === 'await') {
        next();
        return { type: 'Await', arg: parseUnary() };
      }
    }
    return parsePostfix();
  }

  function parsePostfix() {
    let expr = parseCallMember();
    const t = peek();
    if (t.type === 'punc' && (t.value === '++' || t.value === '--')) {
      if (expr.type === 'Ident' || expr.type === 'Member') {
        next();
        expr = { type: 'Update', op: t.value, target: expr, prefix: false };
      }
    }
    return expr;
  }

  function parseCallMember() {
    let expr = parsePrimary();
    for (;;) {
      if (at('.')) {
        next();
        const nameTok = next();
        if (nameTok.type !== 'ident' && nameTok.type !== 'kw') throw syntaxErr('点号后面应该是属性名', nameTok.pos);
        expr = { type: 'Member', obj: expr, prop: { type: 'Str', value: nameTok.value }, computed: false, optional: false };
        continue;
      }
      if (at('?.')) {
        next();
        const nameTok = next();
        if (nameTok.type === 'ident' || nameTok.type === 'kw') {
          expr = { type: 'Member', obj: expr, prop: { type: 'Str', value: nameTok.value }, computed: false, optional: true };
        } else if (nameTok.value === '(') {
          const args = parseArgs();
          expr = { type: 'Call', callee: expr, args, optional: true };
        } else if (nameTok.value === '[') {
          const prop = parseExpression();
          expect(']');
          expr = { type: 'Member', obj: expr, prop, computed: true, optional: true };
        } else {
          throw syntaxErr('?. 后面不合法', nameTok.pos);
        }
        continue;
      }
      if (at('[')) {
        next();
        const prop = parseExpression();
        expect(']');
        expr = { type: 'Member', obj: expr, prop, computed: true, optional: false };
        continue;
      }
      if (at('(')) {
        const args = parseArgs();
        expr = { type: 'Call', callee: expr, args, optional: false };
        continue;
      }
      break;
    }
    return expr;
  }

  function parseArgs() {
    expect('(');
    const args = [];
    while (!at(')')) {
      if (at('...')) throw syntaxErr('沙盒JS不支持展开(...)', peek().pos);
      args.push(parseAssignment());
      if (!eat(',')) break;
    }
    expect(')');
    return args;
  }

  function parsePrimary() {
    unsupported();
    const t = peek();
    if (t.type === 'num') {
      next();
      return { type: 'Num', value: t.value };
    }
    if (t.type === 'str') {
      next();
      return { type: 'Str', value: t.value };
    }
    if (t.type === 'tpl') {
      next();
      const parts = t.value.map((p) => (p.str !== undefined ? { str: p.str } : { expr: parseExpr(p.exprSrc) }));
      return { type: 'Tpl', parts };
    }
    if (t.type === 'ident') {
      next();
      if (at('=>')) {
        next();
        const body = parseArrowBody();
        return { type: 'Arrow', params: [t.value], body, async: false };
      }
      return { type: 'Ident', name: t.value };
    }
    if (t.type === 'kw') {
      if (t.value === 'true' || t.value === 'false') {
        next();
        return { type: 'Bool', value: t.value === 'true' };
      }
      if (t.value === 'null') {
        next();
        return { type: 'Null' };
      }
      if (t.value === 'undefined') {
        next();
        return { type: 'Undefined' };
      }
      if (t.value === 'new') {
        next();
        const nameTok = next();
        if (nameTok.type !== 'ident') throw syntaxErr('new 后面只支持 Error 系列', nameTok.pos);
        const args = parseArgs();
        return { type: 'New', callee: { type: 'Ident', name: nameTok.value }, args };
      }
      if (t.value === 'function') {
        next();
        let name = null;
        if (peek().type === 'ident') name = next().value;
        const params = parseParams();
        const body = parseBlock();
        return { type: 'FuncExpr', name, params, body, async: false };
      }
      if (t.value === 'async') {
        if (peek(1).type === 'ident' && peek(2).value === '=>') {
          next();
          const paramTok = next();
          next();
          const body = parseArrowBody();
          return { type: 'Arrow', params: [paramTok.value], body, async: true };
        }
        if (peek(1).value === '(') {
          const save = i;
          next();
          try {
            const params = parseParams();
            if (at('=>')) {
              next();
              const body = parseArrowBody();
              return { type: 'Arrow', params, body, async: true };
            }
            i = save;
          } catch {
            i = save;
          }
        }
      }
    }
    if (t.type === 'punc' && t.value === '(') {
      // 可能是箭头函数参数表,先试
      const save = i;
      try {
        const params = parseParams();
        if (at('=>')) {
          next();
          const body = parseArrowBody();
          return { type: 'Arrow', params, body, async: false };
        }
      } catch {
        /* 不是箭头函数,回退 */
      }
      i = save;
      next();
      const expr = parseExpression();
      expect(')');
      return expr;
    }
    if (t.type === 'punc' && t.value === '[') {
      next();
      const items = [];
      while (!at(']')) {
        if (at(',')) {
          next();
          items.push({ type: 'Undefined' });
          continue;
        }
        items.push(parseAssignment());
        if (!eat(',')) break;
      }
      expect(']');
      return { type: 'ArrayLit', items };
    }
    if (t.type === 'punc' && t.value === '{') {
      next();
      const props = [];
      while (!at('}')) {
        const keyTok = next();
        let key;
        if (keyTok.type === 'ident' || keyTok.type === 'kw') key = { type: 'Str', value: keyTok.value };
        else if (keyTok.type === 'str') key = { type: 'Str', value: keyTok.value };
        else if (keyTok.type === 'num') key = { type: 'Str', value: String(keyTok.value) };
        else throw syntaxErr('对象的键不合法', keyTok.pos);
        let value;
        if (eat(':')) value = parseAssignment();
        else if (keyTok.type === 'ident') value = { type: 'Ident', name: keyTok.value };
        else throw syntaxErr('对象属性缺少值', keyTok.pos);
        props.push({ key, value });
        if (!eat(',')) break;
      }
      expect('}');
      return { type: 'ObjectLit', props };
    }
    throw syntaxErr(`这里缺少表达式,实际是 ${JSON.stringify(t.value) || '结尾'}`, t.pos);
  }

  function parseArrowBody() {
    if (at('{')) {
      const body = parseBlock();
      return { block: body };
    }
    const expr = parseAssignment();
    return { expr };
  }

  return parseProgram();
}

// 供模板字符串等场景使用:把一段「表达式源码」解析成表达式节点
export function parseExpr(src) {
  const prog = parse(`(${src})`);
  const stmt = prog.body[0];
  if (!stmt || stmt.type !== 'ExprStmt') throw syntaxErr('表达式解析失败', 0);
  return stmt.expr;
}
