import { describe, expect, test } from "bun:test";
import { __userinfoScanCountForTest, redactSecrets, safeErrorText } from "./opencode-http.ts";

/** A frozen copy of `redactSecrets` as it was before the URL-userinfo scan went
 *  linear. It is the parity reference and the slow side of the timing test. */
function oldRedactSecrets(text: string, password?: string): string {
  let out = text;
  if (password) {
    for (const secret of [password, Buffer.from(`opencode:${password}`).toString("base64")]) {
      if (secret) out = out.split(secret).join("[redacted]");
    }
  }
  return (
    out
      .replace(/(password(?:["']?\s*[=:]\s*|\s+))"(?:[^"\\\n]|\\.)*"?/gi, '$1"[redacted]"')
      .replace(/(password(?:["']?\s*[=:]\s*|\s+))'(?:[^'\\\n]|\\.)*'?/gi, "$1'[redacted]'")
      .replace(/(password(?:["']?\s*[=:]\s*|\s+))(?!["'])\S+/gi, "$1[redacted]")
      .replace(/(authorization["']?\s*[:=]\s*["']?)(?:(?:basic|bearer)\s+)?[^\s"']+/gi, "$1[redacted]")
      .replace(/\b(basic|bearer)(\s+)[A-Za-z0-9+/=._~-]{8,}/gi, "$1$2[redacted]")
      .replace(/([a-z][a-z0-9+.-]*:\/\/|^|[\s"'(<=,;[{])([^\s:/@"'<>]+):(?!\/\/)[^\s@"'<>]+@/gi, "$1$2:[redacted]@")
  );
}

const PASSWORD = "s3cr3t-Pw";
const B64 = Buffer.from(`opencode:${PASSWORD}`).toString("base64");

const REALISTIC: string[] = [
  "GET http://opencode:hunter9@127.0.0.1:4096/api/info failed",
  "opencode:hunter8@127.0.0.1",
  "https://user:p%40ss@example.com/path?x=1 and ssh://git:tok@host:22/repo",
  "mail bob@example.com, see [::1]:80, ses_a:msg_b, http://127.0.0.1:4096",
  "Authorization: Bearer abcdef0123456789",
  'headers {"authorization":"Basic Zm9vYmFyYmF6","accept":"*/*"}',
  "curl -H 'Authorization: Basic Zm9vYmFyYmF6' http://h",
  "password=hunter1 token=abc123 other=fine",
  "bad password hunter3 given",
  'password: "a b" and OPENCODE_PASSWORD="two words" tail',
  "{'password': 'hunter6', 'user': 'bob'}",
  '{"url":"http://u:a/b+c@127.0.0.1","password":12345,"nested":{"x":"y:z@w"}}',
  'password="never closed secret5\nnext line',
  "line one\nopencode:pw@host line two\n(http://a:b@c) <x:y@z> a=b:c@d, e;f:g@h [i:j@k] {l:m@n}",
  "no secrets here at all: just text, 3:30pm and a/b/c",
  "plain @mention and : alone and :@ and a:@ and :b@ and a:b@",
  "http://a:b@c@d http://:x@h http://u:@h http://u://x@h ftp://u:p:q@h",
  "1http://u:p@h x1+y.z-://u:p@h _a:b@c é:ü@ñ a b:c@d\u00a0e:f@g",
  `a ${PASSWORD} b ${B64} c http://opencode:${PASSWORD}@127.0.0.1`,
  "",
  "@",
  ":",
  "a:b@",
  "a:b",
];

describe("redactSecrets parity with the pre-linear implementation", () => {
  test.each(REALISTIC.map((s, i) => [i, s] as const))("realistic input %d", (_i, input) => {
    expect(redactSecrets(input, PASSWORD)).toBe(oldRedactSecrets(input, PASSWORD));
    expect(redactSecrets(input)).toBe(oldRedactSecrets(input));
  });

  test("still redacts the userinfo password", () => {
    expect(redactSecrets("GET http://opencode:hunter9@127.0.0.1:4096/api/info failed")).toBe(
      "GET http://opencode:[redacted]@127.0.0.1:4096/api/info failed",
    );
  });

  test("seeded random strings over the pattern's own alphabet", () => {
    const alphabet = ["a", "b", "1", "-", "+", ".", ":", "//", "@", "/", " ", "\n", '"', "'", "(", "<", ">", "=", ",", ";", "[", "{", "http", "://", "é", "\u00a0", "password ", "Bearer "];
    let seed = 0x2f6e2b1;
    const next = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    for (let round = 0; round < 4000; round++) {
      let s = "";
      const len = 1 + (next() % 24);
      for (let k = 0; k < len; k++) s += alphabet[next() % alphabet.length];
      expect(redactSecrets(s)).toBe(oldRedactSecrets(s));
    }
  });
});

describe("redactSecrets runs in linear time", () => {
  // Every input ends in `:@`, so it holds BOTH `@` and `:` (redactUserinfo does
  // not return early) and the tail never forms a match (a password needs a
  // character between `:` and `@`), so the whole string is scanned for nothing.
  // Each is a builder from a size, so the same shape is timed at n and 4n.
  const TAIL = ":@";
  const adversarial: Record<string, (n: number) => string> = {
    "one repeated char": (n) => "a".repeat(n) + TAIL,
    "a: pairs": (n) => "a:".repeat(n / 2) + TAIL,
    "=a: triples": (n) => "=a:".repeat(Math.floor(n / 3)) + TAIL,
    "a:b= groups": (n) => "a:b=".repeat(n / 4) + TAIL,
    "scheme-like runs": (n) => "a://".repeat(n / 4) + TAIL,
    "slashes then tail": (n) => "a/".repeat(n / 2) + TAIL,
  };

  /** The fastest of several runs: robust against a loaded machine, which can
   *  only slow a run down. */
  const best = (fn: () => void): number => {
    let min = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 7; run++) {
      const t0 = performance.now();
      fn();
      min = Math.min(min, performance.now() - t0);
    }
    return min;
  };

  /** time(4n) / time(n): about 4 for linear work, about 16 for quadratic. */
  const scaling = (redact: (s: string) => string, build: (n: number) => string, n: number): number => {
    const small = build(n);
    const big = build(4 * n);
    // Warm up so JIT compilation is not charged to the small side.
    redact(small);
    const tSmall = Math.max(best(() => redact(small)), 0.01);
    const tBig = best(() => redact(big));
    return tBig / tSmall;
  };

  const LINEAR_RATIO_LIMIT = 8;

  test("every adversarial input reaches the scan, and 4x the input costs under 8x the time", () => {
    for (const [name, build] of Object.entries(adversarial)) {
      const before = __userinfoScanCountForTest();
      redactSecrets(build(4096));
      // The scan ran (it did not return at the early `@` / `:` check).
      expect({ name, scanned: __userinfoScanCountForTest() - before }).toEqual({ name, scanned: 1 });
      const ratio = scaling((s) => redactSecrets(s), build, 32 * 1024);
      expect({ name, linear: ratio < LINEAR_RATIO_LIMIT }).toEqual({ name, linear: true });
    }
  });

  test("the pre-linear implementation scales worse than 8x on at least one of them", () => {
    // 4 KB -> 16 KB keeps the quadratic side to a fraction of a second.
    const ratios = Object.values(adversarial).map((build) => scaling((s) => oldRedactSecrets(s), build, 4 * 1024));
    expect(Math.max(...ratios)).toBeGreaterThan(LINEAR_RATIO_LIMIT);
  });

  test("adversarial inputs redact the same as before", () => {
    for (const build of Object.values(adversarial)) {
      const input = build(2000);
      expect(redactSecrets(input)).toBe(oldRedactSecrets(input));
    }
  });
});

describe("safeErrorText bounds its input before redacting", () => {
  test("a 10 MB body completes quickly, keeps its leading text and leaks no secret", () => {
    const body = `request failed password=${PASSWORD} ${"a".repeat(10 * 1024 * 1024)}:@`;
    let min = Number.POSITIVE_INFINITY;
    let out = "";
    for (let run = 0; run < 3; run++) {
      const t0 = performance.now();
      out = safeErrorText(body, PASSWORD);
      min = Math.min(min, performance.now() - t0);
    }
    expect(min).toBeLessThan(50);
    expect(out).not.toContain(PASSWORD);
    expect(out.startsWith("request failed password=[redacted]")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(303);
  });

  test("a secret straddling the cut is never emitted, even as a fragment", () => {
    const pad = "\n".repeat(16 * 1024 - 8);
    // Control characters flatten away, so only the token at the cut could show.
    const body = `${pad}${PASSWORD}${" tail".repeat(100)}`;
    const out = safeErrorText(body, PASSWORD);
    expect(out).not.toContain(PASSWORD);
    expect(out).not.toContain(PASSWORD.slice(0, 4));
    // Short texts are untouched by the bound.
    expect(safeErrorText(`bad ${PASSWORD} here`, PASSWORD)).toBe("bad [redacted] here");
  });
});
