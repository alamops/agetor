import { describe, expect, test } from "bun:test";
import { redactSecrets } from "./opencode-http.ts";

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
  const SIZE = 64 * 1024;
  const adversarial: Record<string, string> = {
    "one repeated char": "a".repeat(SIZE),
    colons: ":".repeat(SIZE),
    ats: "@".repeat(SIZE),
    "a: pairs": "a:".repeat(SIZE / 2),
    "=a: triples": "=a:".repeat(Math.floor(SIZE / 3)),
    "a:b= groups": "a:b=".repeat(SIZE / 4),
    "scheme-like runs": "a://".repeat(SIZE / 4),
  };

  const median = (fn: () => void): number => {
    const times: number[] = [];
    for (let run = 0; run < 5; run++) {
      const t0 = performance.now();
      fn();
      times.push(performance.now() - t0);
    }
    return times.sort((a, b) => a - b)[2] ?? Number.POSITIVE_INFINITY;
  };

  test("every adversarial 64 KB input takes under 10 ms", () => {
    for (const [name, input] of Object.entries(adversarial)) {
      const ms = median(() => redactSecrets(input));
      expect({ name, fast: ms < 10 }).toEqual({ name, fast: true });
    }
  });

  test("the pre-linear implementation takes over 100 ms on a 16 KB one", () => {
    // 16 KB keeps the old side to a fraction of a second (it is quadratic: 64 KB
    // takes seconds); this proves the timing test above can tell the two apart.
    const input = "a".repeat(16 * 1024);
    const ms = median(() => oldRedactSecrets(input));
    expect(ms).toBeGreaterThan(100);
    expect(median(() => redactSecrets(input))).toBeLessThan(10);
  });

  test("adversarial inputs redact the same as before", () => {
    for (const input of Object.values(adversarial).map((s) => s.slice(0, 2000))) {
      expect(redactSecrets(input)).toBe(oldRedactSecrets(input));
    }
  });
});
