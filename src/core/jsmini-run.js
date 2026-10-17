// 迷你 JS 解释器的执行部分(语法分析在 jsmini.js)。
// 异步树遍历实现:每个节点求值都是 async,所以 await 天然可用,
// 配合「步数上限 + 墙钟超时」把死循环挡在门外。

import { parse } from './jsmini.js';

const BLOCKED_PROPS = new Set(['constructor', '__proto__', 'prototype']);
const MAX_RECURSION = 120;
const MAX_STRING = 200000;

class Signal {
  constructor(type, value) {
    this.type = type;
    this.value = value;
  }
}

class Scope {
  constructor(parent = null) {
    this.vars = new Map();
    this.consts = new Set();
    this.parent = parent;
  }

  get(name) {
    if (this.vars.has(name)) return this.vars.get(name);
    if (this.parent) return this.parent.get(name);
    throw new Error(`变量「${name}」没有定义`);
  }

  declare(name, value, isConst = false) {
    this.vars.set(name, value);
    if (isConst) this.consts.add(name);
  }

  assign(name, value) {
    if (this.vars.has(name)) {
      if (this.consts.has(name)) throw new Error(`常量「${name}」不能重新赋值`);
      this.vars.set(name, value);
      return;
    }
    if (this.parent) {
      this.parent.assign(name, value);
      return;
    }
    this.vars.set(name, value);
  }
}

function truthy(v) {
  return !!v;
}

function toNum(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const t = v.trim();
    if (t === '') return 0;
    return Number(t);
  }
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === null) return 0;
  if (v === undefined) return NaN;
  return NaN;
}

function toStr(v) {
  if (typeof v === 'string') return v;
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map((x) => toStr(x)).join(',');
  if (v && v.__fn) return '[函数]';
  if (typeof v === 'function') return '[函数]';
  try {
    return JSON.stringify(v);
  } catch {
    return '[对象]';
  }
}

function looseEq(a, b) {
  if (a === b) return true;
  if (a === null && b === undefined) return true;
  if (a === undefined && b === null) return true;
  if (typeof a === 'number' && typeof b === 'string') return a === Number(b);
  if (typeof a === 'string' && typeof b === 'number') return Number(a) === b;
  if (typeof a === 'boolean') return looseEq(a ? 1 : 0, b);
  if (typeof b === 'boolean') return looseEq(a, b ? 1 : 0);
  return false;
}

function clampString(s) {
  const str = String(s);
  if (str.length > MAX_STRING) throw new Error('字符串太长(超过 20 万字符)');
  return str;
}

export class Interpreter {
  constructor({ globals = {}, timeoutMs = 5000, maxSteps = 500000 } = {}) {
    this.global = new Scope(null);
    this.steps = 0;
    this.maxSteps = Math.max(1000, maxSteps);
    this.deadline = Date.now() + Math.max(200, timeoutMs);
    this.depth = 0;
    this.logs = [];
    for (const [k, v] of Object.entries(globals)) this.global.declare(k, v);
    this.installBuiltins();
  }

  tick() {
    this.steps++;
    if (this.steps > this.maxSteps) throw new Error(`执行步数超过上限(${this.maxSteps} 步),可能是死循环`);
    if ((this.steps & 1023) === 0 && Date.now() > this.deadline) {
      throw new Error('执行超时,已强制停止(可能是死循环或计算太重)');
    }
  }

  log(...args) {
    const line = args.map((a) => toStr(a)).join(' ');
    if (this.logs.length < 200) this.logs.push(line);
  }

  async run(ast) {
    try {
      await this.execStatements(ast.body, this.global, true);
      return undefined;
    } catch (e) {
      if (e instanceof Signal) {
        if (e.type === 'return') return e.value;
        throw new Error(`${e.type === 'break' ? 'break' : 'continue'} 只能出现在循环里`);
      }
      throw e;
    }
  }

  // ------------------------------------------------------------------
  // 语句
  // ------------------------------------------------------------------

  async execStatements(list, scope, hoist = true) {
    if (hoist) {
      for (const stmt of list) {
        if (stmt.type === 'FuncDecl') {
          scope.declare(stmt.name, this.makeFunction(stmt, scope, stmt.name));
        }
      }
    }
    for (const stmt of list) {
      await this.execStatement(stmt, scope);
    }
  }

  async execStatement(node, scope) {
    this.tick();
    switch (node.type) {
      case 'Empty':
        return;
      case 'ExprStmt':
        await this.evalExpr(node.expr, scope);
        return;
      case 'VarDecl': {
        for (const d of node.decls) {
          const v = d.init ? await this.evalExpr(d.init, scope) : undefined;
          scope.declare(d.name, v, node.kind === 'const');
        }
        return;
      }
      case 'Block':
        await this.execStatements(node.body, new Scope(scope));
        return;
      case 'FuncDecl':
        return; // 已在 execStatements 里提升
      case 'If': {
        const t = await this.evalExpr(node.test, scope);
        if (truthy(t)) await this.execStatement(node.cons, scope);
        else if (node.alt) await this.execStatement(node.alt, scope);
        return;
      }
      case 'While': {
        let guard = 0;
        for (;;) {
          this.tick();
          const t = await this.evalExpr(node.test, scope);
          if (!truthy(t)) break;
          try {
            await this.execStatement(node.body, new Scope(scope));
          } catch (e) {
            if (e instanceof Signal && e.type === 'continue') {
              /* 继续 */
            } else if (e instanceof Signal && e.type === 'break') {
              break;
            } else throw e;
          }
          if (++guard > 500000) throw new Error('循环次数过多,已停止');
        }
        return;
      }
      case 'For': {
        const forScope = new Scope(scope);
        if (node.init) {
          if (node.init.type === 'VarDecl') await this.execStatement(node.init, forScope);
          else await this.evalExpr(node.init.expr, forScope);
        }
        let guard = 0;
        for (;;) {
          this.tick();
          if (node.test) {
            const t = await this.evalExpr(node.test, forScope);
            if (!truthy(t)) break;
          }
          try {
            await this.execStatement(node.body, new Scope(forScope));
          } catch (e) {
            if (e instanceof Signal && e.type === 'continue') {
              /* 继续,跑 update */
            } else if (e instanceof Signal && e.type === 'break') {
              break;
            } else throw e;
          }
          if (node.update) await this.evalExpr(node.update, forScope);
          if (++guard > 500000) throw new Error('循环次数过多,已停止');
        }
        return;
      }
      case 'ForOf': {
        const iterable = await this.evalExpr(node.iterable, scope);
        let items;
        if (Array.isArray(iterable)) items = iterable;
        else if (typeof iterable === 'string') items = [...iterable];
        else throw new Error('for-of 只能遍历数组或字符串');
        let guard = 0;
        for (const item of items) {
          this.tick();
          const iterScope = new Scope(scope);
          if (node.name) iterScope.declare(node.name, item, node.kind === 'const');
          try {
            await this.execStatement(node.body, iterScope);
          } catch (e) {
            if (e instanceof Signal && e.type === 'continue') continue;
            if (e instanceof Signal && e.type === 'break') break;
            throw e;
          }
          if (++guard > 500000) throw new Error('循环次数过多,已停止');
        }
        return;
      }
      case 'Return':
        throw new Signal('return', node.arg ? await this.evalExpr(node.arg, scope) : undefined);
      case 'Break':
        throw new Signal('break', undefined);
      case 'Continue':
        throw new Signal('continue', undefined);
      case 'Throw':
        throw await this.evalExpr(node.arg, scope);
      case 'Try': {
        try {
          await this.execStatement(node.block, new Scope(scope));
        } catch (e) {
          if (e instanceof Signal) throw e;
          if (node.catchBody) {
            const cs = new Scope(scope);
            if (node.catchParam) cs.declare(node.catchParam, e);
            await this.execStatement(node.catchBody, cs);
          } else {
            throw e;
          }
        } finally {
          if (node.finallyBody) await this.execStatement(node.finallyBody, new Scope(scope));
        }
        return;
      }
      default:
        throw new Error(`不支持的语句:${node.type}`);
    }
  }

  // ------------------------------------------------------------------
  // 表达式
  // ------------------------------------------------------------------

  async evalExpr(node, scope) {
    this.tick();
    switch (node.type) {
      case 'Num':
      case 'Str':
      case 'Bool':
        return node.value;
      case 'Null':
        return null;
      case 'Undefined':
        return undefined;
      case 'Ident':
        return scope.get(node.name);
      case 'Tpl': {
        let out = '';
        for (const part of node.parts) {
          if (part.str !== undefined) out += part.str;
          else out += toStr(await this.evalExpr(part.expr, scope));
        }
        return clampString(out);
      }
      case 'ArrayLit': {
        const arr = [];
        for (const item of node.items) arr.push(await this.evalExpr(item, scope));
        return arr;
      }
      case 'ObjectLit': {
        const obj = Object.create(null);
        for (const p of node.props) {
          obj[await this.evalExpr(p.key, scope)] = await this.evalExpr(p.value, scope);
        }
        return obj;
      }
      case 'FuncExpr':
      case 'Arrow': {
        const fn = this.makeFunction(node, scope, node.name || '匿名函数');
        return fn;
      }
      case 'Unary':
        return await this.evalUnary(node, scope);
      case 'Update': {
        const cur = await this.evalTarget(node.target, scope);
        const next = node.op === '++' ? toNum(cur) + 1 : toNum(cur) - 1;
        await this.assignTarget(node.target, next, scope);
        return node.prefix ? next : cur;
      }
      case 'Binary':
        return await this.evalBinary(node, scope);
      case 'Logical': {
        const left = await this.evalExpr(node.left, scope);
        if (node.op === '&&') return truthy(left) ? await this.evalExpr(node.right, scope) : left;
        if (node.op === '||') return truthy(left) ? left : await this.evalExpr(node.right, scope);
        return left === null || left === undefined ? await this.evalExpr(node.right, scope) : left;
      }
      case 'Ternary': {
        const t = await this.evalExpr(node.test, scope);
        return truthy(t) ? await this.evalExpr(node.cons, scope) : await this.evalExpr(node.alt, scope);
      }
      case 'Sequence': {
        await this.evalExpr(node.left, scope);
        return await this.evalExpr(node.right, scope);
      }
      case 'Assign': {
        const value = await this.evalExpr(node.value, scope);
        if (node.op === '=') {
          await this.assignTarget(node.target, value, scope);
          return value;
        }
        const cur = await this.evalTarget(node.target, scope);
        const op = node.op.slice(0, -1);
        const next = this.applyBinaryOp(op, cur, value);
        await this.assignTarget(node.target, next, scope);
        return next;
      }
      case 'Member': {
        const obj = await this.evalExpr(node.obj, scope);
        if (obj === null || obj === undefined) {
          if (node.optional) return undefined;
          throw new Error(`读取属性时遇到 ${obj === null ? 'null' : 'undefined'}`);
        }
        const prop = node.computed ? await this.evalExpr(node.prop, scope) : node.prop.value;
        return this.getProp(obj, prop);
      }
      case 'Call':
        return await this.evalCall(node, scope);
      case 'Await': {
        const v = await this.evalExpr(node.arg, scope);
        return await v;
      }
      case 'New': {
        const name = node.callee.name;
        const args = [];
        for (const a of node.args) args.push(await this.evalExpr(a, scope));
        if (['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError'].includes(name)) {
          const err = new Error(toStr(args[0] ?? ''));
          err.name = name;
          return err;
        }
        throw new Error(`沙盒JS的 new 只支持 Error 系列,不支持 new ${name}(...)`);
      }
      default:
        throw new Error(`不支持的表达式:${node.type}`);
    }
  }

  async evalUnary(node, scope) {
    if (node.op === 'typeof') {
      try {
        const v = await this.evalExpr(node.arg, scope);
        if (v === null) return 'object';
        if (v && v.__fn) return 'function';
        return typeof v;
      } catch {
        return 'undefined';
      }
    }
    const v = await this.evalExpr(node.arg, scope);
    switch (node.op) {
      case '!':
        return !truthy(v);
      case '-':
        return -toNum(v);
      case '+':
        return toNum(v);
      case '~':
        return ~Math.trunc(toNum(v));
      case 'void':
        return undefined;
      default:
        throw new Error(`不支持的运算符 ${node.op}`);
    }
  }

  applyBinaryOp(op, l, r) {
    switch (op) {
      case '+':
        if (typeof l === 'string' || typeof r === 'string' || (l && typeof l === 'object') || (r && typeof r === 'object')) {
          return clampString(toStr(l) + toStr(r));
        }
        return toNum(l) + toNum(r);
      case '-':
        return toNum(l) - toNum(r);
      case '*':
        return toNum(l) * toNum(r);
      case '/':
        return toNum(l) / toNum(r);
      case '%':
        return toNum(l) % toNum(r);
      case '**':
        return toNum(l) ** toNum(r);
      case '<<':
        return Math.trunc(toNum(l)) << Math.trunc(toNum(r));
      case '>>':
        return Math.trunc(toNum(l)) >> Math.trunc(toNum(r));
      case '&':
        return Math.trunc(toNum(l)) & Math.trunc(toNum(r));
      case '|':
        return Math.trunc(toNum(l)) | Math.trunc(toNum(r));
      case '^':
        return Math.trunc(toNum(l)) ^ Math.trunc(toNum(r));
      case '==':
        return looseEq(l, r);
      case '===':
        return l === r;
      case '!=':
        return !looseEq(l, r);
      case '!==':
        return l !== r;
      case '<':
        if (typeof l === 'string' && typeof r === 'string') return l < r;
        return toNum(l) < toNum(r);
      case '>':
        if (typeof l === 'string' && typeof r === 'string') return l > r;
        return toNum(l) > toNum(r);
      case '<=':
        if (typeof l === 'string' && typeof r === 'string') return l <= r;
        return toNum(l) <= toNum(r);
      case '>=':
        if (typeof l === 'string' && typeof r === 'string') return l >= r;
        return toNum(l) >= toNum(r);
      default:
        throw new Error(`不支持的运算符 ${op}`);
    }
  }

  async evalBinary(node, scope) {
    const l = await this.evalExpr(node.left, scope);
    const r = await this.evalExpr(node.right, scope);
    return this.applyBinaryOp(node.op, l, r);
  }

  async evalCall(node, scope) {
    // 方法调用:obj.method(...) —— 走方法表,支持字符串/数组/数字的方法
    if (node.callee.type === 'Member') {
      const recv = await this.evalExpr(node.callee.obj, scope);
      if (recv === null || recv === undefined) {
        if (node.callee.optional || node.optional) return undefined;
        throw new Error('调用方法时遇到 null / undefined');
      }
      const name = node.callee.computed
        ? await this.evalExpr(node.callee.prop, scope)
        : node.callee.prop.value;
      const method = this.methodFor(recv, String(name));
      const args = [];
      for (const a of node.args) args.push(await this.evalExpr(a, scope));
      if (method) return await method(recv, args);
      const fn = this.getProp(recv, name);
      if (fn === undefined || fn === null) {
        throw new Error(`对象上没有 ${String(name)} 这个方法`);
      }
      return await this.callValue(fn, args);
    }
    const fn = await this.evalExpr(node.callee, scope);
    if (fn === null || fn === undefined) {
      if (node.optional) return undefined;
      throw new Error('调用的不是一个函数');
    }
    const args = [];
    for (const a of node.args) args.push(await this.evalExpr(a, scope));
    return await this.callValue(fn, args);
  }

  async callValue(fn, args) {
    if (fn && fn.__fn) return await this.callInterpreted(fn, args);
    if (typeof fn === 'function') return await fn(...args);
    throw new Error('调用的不是一个函数');
  }

  makeFunction(node, scope, name) {
    return { __fn: true, node, scope, name };
  }

  async callInterpreted(fn, args) {
    this.depth++;
    if (this.depth > MAX_RECURSION) {
      this.depth--;
      throw new Error(`递归太深(超过 ${MAX_RECURSION} 层)`);
    }
    try {
      const scope = new Scope(fn.scope);
      const params = fn.node.params || [];
      for (let i = 0; i < params.length; i++) scope.declare(params[i], args[i]);
      const node = fn.node;
      if (node.type === 'Arrow' && node.body && node.body.expr) {
        return await this.evalExpr(node.body.expr, scope);
      }
      const body = node.type === 'Arrow' ? node.body.block : node.body;
      try {
        await this.execStatements(body.body, scope, true);
      } catch (e) {
        if (e instanceof Signal && e.type === 'return') return e.value;
        if (e instanceof Signal) throw new Error(`${e.type} 只能出现在循环里`);
        throw e;
      }
      return undefined;
    } finally {
      this.depth--;
    }
  }

  async evalTarget(target, scope) {
    if (target.type === 'Ident') return scope.get(target.name);
    const obj = await this.evalExpr(target.obj, scope);
    const prop = target.computed ? await this.evalExpr(target.prop, scope) : target.prop.value;
    return this.getProp(obj, prop);
  }

  async assignTarget(target, value, scope) {
    if (target.type === 'Ident') {
      scope.assign(target.name, value);
      return;
    }
    const obj = await this.evalExpr(target.obj, scope);
    const prop = target.computed ? await this.evalExpr(target.prop, scope) : target.prop.value;
    this.setProp(obj, prop, value);
  }

  getProp(obj, prop) {
    const key = String(prop);
    if (BLOCKED_PROPS.has(key)) return undefined;
    if (typeof obj === 'string') {
      if (key === 'length') return obj.length;
      const i = Number(key);
      if (Number.isInteger(i) && i >= 0 && i < obj.length) return obj[i];
      return undefined;
    }
    if (Array.isArray(obj)) {
      if (key === 'length') return obj.length;
      const i = Number(key);
      if (Number.isInteger(i)) return obj[i];
      return obj[key];
    }
    if (obj && typeof obj === 'object') {
      return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
    }
    return undefined;
  }

  setProp(obj, prop, value) {
    const key = String(prop);
    if (BLOCKED_PROPS.has(key)) throw new Error('不允许修改该属性');
    if (obj === null || obj === undefined) throw new Error('给 null / undefined 设置属性');
    if (typeof obj === 'string') throw new Error('字符串不可修改');
    if (Array.isArray(obj)) {
      if (key === 'length') {
        obj.length = Math.max(0, Math.trunc(toNum(value)));
        return;
      }
      const i = Number(key);
      if (Number.isInteger(i) && i >= 0) {
        obj[i] = value;
        return;
      }
      obj[key] = value;
      return;
    }
    if (typeof obj === 'object') {
      obj[key] = value;
      return;
    }
    throw new Error('这个值不可修改');
  }

  // ------------------------------------------------------------------
  // 方法表:字符串 / 数组 / 数字 / 对象上的常用方法
  // ------------------------------------------------------------------

  methodFor(recv, name) {
    const str = typeof recv === 'string';
    const arr = Array.isArray(recv);
    const num = typeof recv === 'number';
    const obj = recv && typeof recv === 'object' && !arr;

    if (str) {
      const S = {
        charAt: (s, a) => s.charAt(a[0] | 0),
        charCodeAt: (s, a) => s.charCodeAt(a[0] | 0),
        at: (s, a) => s.at(a[0] | 0),
        slice: (s, a) => s.slice(a[0] === undefined ? undefined : toNum(a[0]), a[1] === undefined ? undefined : toNum(a[1])),
        substring: (s, a) => s.substring(a[0] === undefined ? undefined : toNum(a[0]), a[1] === undefined ? undefined : toNum(a[1])),
        substr: (s, a) => s.substr(a[0] === undefined ? undefined : toNum(a[0]), a[1] === undefined ? undefined : toNum(a[1])),
        indexOf: (s, a) => s.indexOf(toStr(a[0]), a[1] === undefined ? 0 : toNum(a[1])),
        lastIndexOf: (s, a) => s.lastIndexOf(toStr(a[0])),
        includes: (s, a) => s.includes(toStr(a[0])),
        startsWith: (s, a) => s.startsWith(toStr(a[0])),
        endsWith: (s, a) => s.endsWith(toStr(a[0])),
        split: (s, a) => (a[0] === undefined ? [s] : s.split(toStr(a[0]), a[1] === undefined ? undefined : toNum(a[1]))),
        replace: (s, a) => s.replace(toStr(a[0]), toStr(a[1])),
        replaceAll: (s, a) => s.split(toStr(a[0])).join(toStr(a[1])),
        toUpperCase: (s) => s.toUpperCase(),
        toLowerCase: (s) => s.toLowerCase(),
        trim: (s) => s.trim(),
        trimStart: (s) => s.trimStart(),
        trimEnd: (s) => s.trimEnd(),
        repeat: (s, a) => s.repeat(Math.max(0, Math.trunc(toNum(a[0])))),
        padStart: (s, a) => s.padStart(Math.trunc(toNum(a[0])), a[1] === undefined ? ' ' : toStr(a[1])),
        padEnd: (s, a) => s.padEnd(Math.trunc(toNum(a[0])), a[1] === undefined ? ' ' : toStr(a[1])),
        concat: (s, a) => s + a.map((x) => toStr(x)).join(''),
        toString: (s) => s,
        valueOf: (s) => s,
        localeCompare: (s, a) => (s < toStr(a[0]) ? -1 : s > toStr(a[0]) ? 1 : 0),
      };
      return S[name] || undefined;
    }

    if (arr) {
      const A = {
        push: (x, a) => x.push(...a),
        pop: (x) => x.pop(),
        shift: (x) => x.shift(),
        unshift: (x, a) => x.unshift(...a),
        slice: (x, a) => x.slice(a[0] === undefined ? undefined : toNum(a[0]), a[1] === undefined ? undefined : toNum(a[1])),
        splice: (x, a) => {
          const start = a[0] === undefined ? 0 : toNum(a[0]);
          const del = a[1] === undefined ? x.length - start : toNum(a[1]);
          return x.splice(start, del, ...a.slice(2));
        },
        concat: (x, a) => x.concat(...a.filter(Array.isArray)),
        join: (x, a) => x.map((v) => toStr(v)).join(a[0] === undefined ? ',' : toStr(a[0])),
        indexOf: (x, a) => x.indexOf(a[0]),
        lastIndexOf: (x, a) => x.lastIndexOf(a[0]),
        includes: (x, a) => x.includes(a[0]),
        at: (x, a) => x.at(a[0] | 0),
        reverse: (x) => {
          x.reverse();
          return x;
        },
        sort: (x, a) => {
          const cb = a[0];
          if (cb && (cb.__fn || typeof cb === 'function')) {
            // 比较函数可能被解释器函数占用(异步),这里退化成同步比较会失真;
            // 用简单的插入排序支持异步比较
            return this.sortAsync(x, cb);
          }
          x.sort((p, q) => (toStr(p) < toStr(q) ? -1 : toStr(p) > toStr(q) ? 1 : 0));
          return x;
        },
        toString: (x) => x.map((v) => toStr(v)).join(','),
      };
      const callbacks = {
        map: (x, a) => Promise.all(x.map(async (v, i) => this.callValue(a[0], [v, i, x]))),
        filter: async (x, a) => {
          const out = [];
          for (let i = 0; i < x.length; i++) {
            if (truthy(await this.callValue(a[0], [x[i], i, x]))) out.push(x[i]);
          }
          return out;
        },
        forEach: async (x, a) => {
          for (let i = 0; i < x.length; i++) await this.callValue(a[0], [x[i], i, x]);
          return undefined;
        },
        find: async (x, a) => {
          for (let i = 0; i < x.length; i++) {
            if (truthy(await this.callValue(a[0], [x[i], i, x]))) return x[i];
          }
          return undefined;
        },
        findIndex: async (x, a) => {
          for (let i = 0; i < x.length; i++) {
            if (truthy(await this.callValue(a[0], [x[i], i, x]))) return i;
          }
          return -1;
        },
        some: async (x, a) => {
          for (let i = 0; i < x.length; i++) {
            if (truthy(await this.callValue(a[0], [x[i], i, x]))) return true;
          }
          return false;
        },
        every: async (x, a) => {
          for (let i = 0; i < x.length; i++) {
            if (!truthy(await this.callValue(a[0], [x[i], i, x]))) return false;
          }
          return true;
        },
        reduce: async (x, a) => {
          let acc;
          let start = 0;
          if (a.length >= 2) acc = a[1];
          else {
            if (!x.length) throw new Error('空数组不能不带初始值 reduce');
            acc = x[0];
            start = 1;
          }
          for (let i = start; i < x.length; i++) acc = await this.callValue(a[0], [acc, x[i], i, x]);
          return acc;
        },
      };
      if (callbacks[name]) return callbacks[name];
      return A[name] || undefined;
    }

    if (num) {
      const N = {
        toFixed: (n, a) => n.toFixed(Math.max(0, Math.min(20, Math.trunc(toNum(a[0] ?? 0))))),
        toString: (n, a) => (a[0] ? n.toString(Math.trunc(toNum(a[0]))) : String(n)),
        valueOf: (n) => n,
      };
      return N[name] || undefined;
    }

    if (obj) {
      const O = {
        toString: () => '[object]',
        valueOf: () => recv,
      };
      return O[name] || undefined;
    }

    return undefined;
  }

  async sortAsync(arr, cb) {
    // 插入排序(支持异步比较函数),数组一般都很小
    for (let i = 1; i < arr.length; i++) {
      const cur = arr[i];
      let j = i - 1;
      while (j >= 0) {
        const cmp = toNum(await this.callValue(cb, [arr[j], cur]));
        if (cmp <= 0) break;
        arr[j + 1] = arr[j];
        j--;
      }
      arr[j + 1] = cur;
    }
    return arr;
  }

  // ------------------------------------------------------------------
  // 内置全局
  // ------------------------------------------------------------------

  installBuiltins() {
    const g = this.global;
    g.declare('NaN', NaN);
    g.declare('Infinity', Infinity);
    g.declare('undefined', undefined);

    const math = Object.create(null);
    for (const k of ['abs', 'floor', 'ceil', 'round', 'trunc', 'sign', 'sqrt', 'cbrt', 'pow', 'exp', 'log', 'log2', 'log10', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'min', 'max', 'hypot']) {
      math[k] = (...args) => Math[k](...args.map((x) => toNum(x)));
    }
    math.random = () => Math.random();
    math.PI = Math.PI;
    math.E = Math.E;
    g.declare('Math', math);

    const json = Object.create(null);
    json.parse = (s) => {
      try {
        return JSON.parse(toStr(s));
      } catch (e) {
        throw new Error(`JSON.parse 失败:${e?.message || e}`);
      }
    };
    json.stringify = (v, replacer, indent) => JSON.stringify(v, null, typeof indent === 'number' ? indent : undefined) ?? undefined;
    g.declare('JSON', json);

    const object = Object.create(null);
    object.keys = (o) => (o && typeof o === 'object' ? Object.keys(o) : []);
    object.values = (o) => (o && typeof o === 'object' ? Object.values(o) : []);
    object.entries = (o) => (o && typeof o === 'object' ? Object.entries(o).map(([k, v]) => [k, v]) : []);
    object.assign = (target, ...sources) => {
      const t = target && typeof target === 'object' ? target : Object.create(null);
      for (const s of sources) {
        if (s && typeof s === 'object') for (const k of Object.keys(s)) t[k] = s[k];
      }
      return t;
    };
    object.freeze = (o) => o;
    g.declare('Object', object);

    const array = Object.create(null);
    array.isArray = (v) => Array.isArray(v);
    array.from = (v) => {
      if (Array.isArray(v)) return [...v];
      if (typeof v === 'string') return [...v];
      return [];
    };
    g.declare('Array', array);

    g.declare('String', (v) => toStr(v));
    g.declare('Number', (v) => toNum(v));
    g.declare('Boolean', (v) => truthy(v));
    g.declare('parseInt', (s, radix) => parseInt(toStr(s), radix ? toNum(radix) : 10));
    g.declare('parseFloat', (s) => parseFloat(toStr(s)));
    g.declare('isNaN', (v) => Number.isNaN(toNum(v)));
    g.declare('isFinite', (v) => Number.isFinite(toNum(v)));
    g.declare('encodeURIComponent', (s) => encodeURIComponent(toStr(s)));
    g.declare('decodeURIComponent', (s) => decodeURIComponent(toStr(s)));

    const date = Object.create(null);
    date.now = () => Date.now();
    g.declare('Date', date);

    const consoleObj = Object.create(null);
    consoleObj.log = (...args) => {
      this.log(...args);
      return undefined;
    };
    consoleObj.error = consoleObj.log;
    consoleObj.warn = consoleObj.log;
    g.declare('console', consoleObj);
  }
}

/**
 * 跑一段沙盒 JS。
 * @param {string} code 源码
 * @param {object} options globals(注入的全局变量)/ timeoutMs / maxSteps
 * @returns {Promise<{value: any, logs: string[]}>}
 */
export async function runProgram(code, options = {}) {
  const src = String(code || '');
  if (!src.trim()) throw new Error('代码是空的');
  const ast = parse(src);
  const interp = new Interpreter(options);
  const value = await interp.run(ast);
  return { value, logs: interp.logs };
}

// 把解释器里的值整理成可以放进工具结果/HTTP 响应的形式
export function formatValue(v) {
  if (typeof v === 'string') return v;
  if (v === undefined) return '';
  if (v === null) return 'null';
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return toStr(v);
  }
}
