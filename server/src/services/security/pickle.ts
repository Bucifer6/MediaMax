/**
 * Just enough of Python's pickle format to talk to fail2ban's control socket.
 *
 * - encode(): a list of strings, which is every fail2ban command (protocol 2).
 * - decode(): the plain data fail2ban answers with: None/bool/int/float/str/bytes and
 *   lists/tuples/dicts of those. Anything that would construct objects or call code
 *   (GLOBAL, REDUCE, BUILD, INST, OBJ, NEWOBJ, STACK_GLOBAL, PERSID…) is rejected, so a
 *   hostile socket can't make us do more than return data.
 */

export function encodeCommand(args: string[]): Buffer {
  const parts: Buffer[] = [Buffer.from([0x80, 2, 0x5d /* EMPTY_LIST */, 0x28 /* MARK */])];
  for (const a of args) {
    const s = Buffer.from(String(a), 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32LE(s.length);
    parts.push(Buffer.from([0x58 /* BINUNICODE */]), len, s);
  }
  parts.push(Buffer.from([0x65 /* APPENDS */, 0x2e /* STOP */]));
  return Buffer.concat(parts);
}

export type PyValue = null | boolean | number | bigint | string | Buffer | PyValue[] | { [k: string]: PyValue };

class Mark {}
const MARK = new Mark();

const SAFE_BUILTINS = new Set(['str', 'int', 'float', 'bool', 'list', 'tuple', 'set', 'frozenset', 'dict']);
/** A builtin type used as a constructor, e.g. str('1.2.3.4'). Produces plain data only. */
class SafeCtor {
  constructor(readonly name: string) {}
  apply(args: PyValue[]): PyValue {
    const a = args[0];
    switch (this.name) {
      case 'str': return a == null ? '' : typeof a === 'string' ? a : String(a);
      case 'int': return typeof a === 'number' ? Math.trunc(a) : Number.parseInt(String(a ?? 0), 10);
      case 'float': return Number(a ?? 0);
      case 'bool': return !!a;
      case 'dict': return (a && typeof a === 'object' && !Array.isArray(a) ? a : {}) as PyValue;
      default: return Array.isArray(a) ? [...a] : a == null ? [] : [a]; // list/tuple/set/frozenset
    }
  }
}

export function decode(buf: Buffer): PyValue {
  const stack: unknown[] = [];
  const memo: unknown[] = [];
  let i = 0;
  const popMark = () => {
    const out: unknown[] = [];
    for (;;) {
      if (!stack.length) throw new Error('pickle: missing MARK');
      const v = stack.pop();
      if (v === MARK) break;
      out.unshift(v);
    }
    return out;
  };
  const u8 = () => buf[i++];
  const u32 = () => {
    const v = buf.readUInt32LE(i);
    i += 4;
    return v;
  };
  const take = (n: number) => {
    if (i + n > buf.length) throw new Error('pickle: truncated');
    const b = buf.subarray(i, i + n);
    i += n;
    return b;
  };
  const top = () => stack[stack.length - 1];
  while (i < buf.length) {
    const op = u8();
    switch (op) {
      case 0x80: i++; break; // PROTO
      case 0x95: i += 8; break; // FRAME
      case 0x2e: { // STOP
        const v = stack.pop();
        return v as PyValue;
      }
      case 0x28: stack.push(MARK); break; // MARK
      case 0x4e: stack.push(null); break; // NONE
      case 0x88: stack.push(true); break; // NEWTRUE
      case 0x89: stack.push(false); break; // NEWFALSE
      case 0x4b: stack.push(u8()); break; // BININT1
      case 0x4d: stack.push(buf.readUInt16LE(i)); i += 2; break; // BININT2
      case 0x4a: stack.push(buf.readInt32LE(i)); i += 4; break; // BININT
      case 0x8a: { // LONG1
        const n = u8();
        const b = take(n);
        let v = 0n;
        for (let k = n - 1; k >= 0; k--) v = (v << 8n) | BigInt(b[k]);
        if (n && b[n - 1] & 0x80) v -= 1n << BigInt(8 * n);
        stack.push(v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v);
        break;
      }
      case 0x47: stack.push(buf.readDoubleBE(i)); i += 8; break; // BINFLOAT
      case 0x8c: { const n = u8(); stack.push(take(n).toString('utf8')); break; } // SHORT_BINUNICODE
      case 0x58: { const n = u32(); stack.push(take(n).toString('utf8')); break; } // BINUNICODE
      case 0x8d: { const n = Number(buf.readBigUInt64LE(i)); i += 8; stack.push(take(n).toString('utf8')); break; } // BINUNICODE8
      case 0x43: { const n = u8(); stack.push(Buffer.from(take(n))); break; } // SHORT_BINBYTES
      case 0x42: { const n = u32(); stack.push(Buffer.from(take(n))); break; } // BINBYTES
      case 0x5d: stack.push([]); break; // EMPTY_LIST
      case 0x29: stack.push([]); break; // EMPTY_TUPLE (tuples become arrays)
      case 0x7d: stack.push({}); break; // EMPTY_DICT
      case 0x8f: stack.push([]); break; // EMPTY_SET (as a list)
      case 0x85: stack.push([stack.pop()]); break; // TUPLE1
      case 0x86: { const b = stack.pop(); const a = stack.pop(); stack.push([a, b]); break; } // TUPLE2
      case 0x87: { const c = stack.pop(); const b = stack.pop(); const a = stack.pop(); stack.push([a, b, c]); break; } // TUPLE3
      case 0x74: stack.push(popMark()); break; // TUPLE
      case 0x6c: stack.push(popMark()); break; // LIST
      case 0x61: { const v = stack.pop(); (top() as unknown[]).push(v); break; } // APPEND
      case 0x65: { const items = popMark(); (top() as unknown[]).push(...items); break; } // APPENDS
      case 0x90: { const items = popMark(); (top() as unknown[]).push(...items); break; } // ADDITEMS (set)
      case 0x73: { const v = stack.pop(); const k = stack.pop(); (top() as Record<string, unknown>)[String(k)] = v; break; } // SETITEM
      case 0x75: { // SETITEMS
        const items = popMark();
        const d = top() as Record<string, unknown>;
        for (let k = 0; k + 1 < items.length; k += 2) d[String(items[k])] = items[k + 1];
        break;
      }
      case 0x94: memo.push(top()); break; // MEMOIZE
      case 0x71: memo[u8()] = top(); break; // BINPUT
      case 0x72: memo[u32()] = top(); break; // LONG_BINPUT
      case 0x68: stack.push(memo[u8()]); break; // BINGET
      case 0x6a: stack.push(memo[u32()]); break; // LONG_BINGET
      case 0x93: { // STACK_GLOBAL — only plain builtin type constructors (fail2ban pickles IP objects as builtins.str(...))
        const name = stack.pop();
        const mod = stack.pop();
        if (mod !== 'builtins' || typeof name !== 'string' || !SAFE_BUILTINS.has(name)) throw new Error(`pickle: refusing ${String(mod)}.${String(name)}`);
        stack.push(new SafeCtor(name));
        break;
      }
      case 0x52: { // REDUCE — apply a SafeCtor to its argument tuple
        const args = stack.pop();
        const fn = stack.pop();
        if (!(fn instanceof SafeCtor) || !Array.isArray(args)) throw new Error('pickle: refusing REDUCE');
        stack.push(fn.apply(args as PyValue[]));
        break;
      }
      default:
        throw new Error(`pickle: unsupported opcode 0x${op.toString(16)} (refused for safety)`);
    }
  }
  throw new Error('pickle: no STOP');
}
