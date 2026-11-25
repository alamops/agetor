/**
 * RFC 8785 (JCS) canonical JSON, plus a strict parser that refuses duplicate keys.
 *
 * Number formatting is the ECMAScript Number-to-string algorithm, which is what RFC 8785 §3.2.2.3 specifies,
 * so `JSON.stringify` on a finite number is the canonical form. Keys sort by UTF-16 code unit.
 */
import { utf8 } from "./bytes.ts";

export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalJsonError";
  }
}

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function assertWellFormed(s: string): void {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (!(d >= 0xdc00 && d <= 0xdfff)) throw new CanonicalJsonError("lone surrogate");
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      throw new CanonicalJsonError("lone surrogate");
    }
  }
}

function ser(v: unknown, out: string[]): void {
  if (v === null) return void out.push("null");
  switch (typeof v) {
    case "boolean":
      return void out.push(v ? "true" : "false");
    case "number":
      if (!Number.isFinite(v)) throw new CanonicalJsonError("non-finite number");
      return void out.push(JSON.stringify(v));
    case "string":
      assertWellFormed(v);
      return void out.push(JSON.stringify(v));
    case "object": {
      if (Array.isArray(v)) {
        out.push("[");
        for (let i = 0; i < v.length; i++) {
          if (i) out.push(",");
          ser(v[i], out);
        }
        out.push("]");
        return;
      }
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) throw new CanonicalJsonError("not a plain object");
      const keys = Object.keys(v as object).sort();
      out.push("{");
      let first = true;
      for (const k of keys) {
        const val = (v as Record<string, unknown>)[k];
        if (val === undefined) throw new CanonicalJsonError("undefined value");
        if (!first) out.push(",");
        first = false;
        assertWellFormed(k);
        out.push(JSON.stringify(k), ":");
        ser(val, out);
      }
      out.push("}");
      return;
    }
    default:
      throw new CanonicalJsonError(`unsupported type ${typeof v}`);
  }
}

export function canonicalize(v: unknown): string {
  const out: string[] = [];
  ser(v, out);
  return out.join("");
}

export function canonicalBytes(v: unknown): Uint8Array {
  return utf8(canonicalize(v));
}

/** A strict JSON parser: standard JSON only, duplicate keys and non-finite or oversized numbers refused. */
export function parseJsonStrict(text: string, maxDepth = 64): Json {
  let i = 0;
  const n = text.length;
  const fail = (m: string): never => {
    throw new CanonicalJsonError(`${m} at ${i}`);
  };
  const ws = () => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13) i++;
      else break;
    }
  };
  const str = (): string => {
    // text[i] === '"'
    const start = i;
    i++;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 34) {
        i++;
        const raw = text.slice(start, i);
        try {
          return JSON.parse(raw) as string;
        } catch {
          return fail("bad string");
        }
      }
      if (c === 92) i += 2;
      else if (c < 32) return fail("control character in string");
      else i++;
    }
    return fail("unterminated string");
  };
  const value = (depth: number): Json => {
    if (depth > maxDepth) return fail("too deep");
    ws();
    const c = text[i];
    if (c === "{") {
      i++;
      const obj: { [k: string]: Json } = Object.create(null) as { [k: string]: Json };
      ws();
      if (text[i] === "}") {
        i++;
        return { ...obj };
      }
      for (;;) {
        ws();
        if (text[i] !== '"') return fail("expected key");
        const k = str();
        if (Object.prototype.hasOwnProperty.call(obj, k)) return fail("duplicate key");
        ws();
        if (text[i] !== ":") return fail("expected colon");
        i++;
        obj[k] = value(depth + 1);
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "}") {
          i++;
          break;
        }
        return fail("expected , or }");
      }
      return { ...obj };
    }
    if (c === "[") {
      i++;
      const arr: Json[] = [];
      ws();
      if (text[i] === "]") {
        i++;
        return arr;
      }
      for (;;) {
        arr.push(value(depth + 1));
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "]") {
          i++;
          break;
        }
        return fail("expected , or ]");
      }
      return arr;
    }
    if (c === '"') return str();
    if (text.startsWith("true", i)) {
      i += 4;
      return true;
    }
    if (text.startsWith("false", i)) {
      i += 5;
      return false;
    }
    if (text.startsWith("null", i)) {
      i += 4;
      return null;
    }
    const m = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(i, i + 400));
    if (!m) return fail("unexpected token");
    i += m[0].length;
    const num = Number(m[0]);
    if (!Number.isFinite(num)) return fail("non-finite number");
    return num;
  };
  const v = value(0);
  ws();
  if (i !== n) fail("trailing data");
  return v;
}
