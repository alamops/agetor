# Vectors

Every file is a contract the three implementations (TypeScript core, Swift, Kotlin) must pass.

| File | Source | Owner |
| --- | --- | --- |
| `agetor-canonical-json.json` | RFC 8785 + Agetor cases | `scripts/gen-vectors.ts` |
| `agetor-es256.json` | Agetor: low-S and high-S signatures | `scripts/gen-vectors.ts` |
| `agetor-derive.json` | Agetor: HKDF derivations (also cross-checked with node:crypto) | `scripts/gen-vectors.ts` |
| `agetor-padding.json` | Agetor | `scripts/gen-vectors.ts` |
| `agetor-relay-frames.json` | Agetor relay framing | `scripts/gen-vectors.ts` |
| `agetor-envelope.json` | Agetor | `scripts/gen-vectors.ts` |
| `cacophony-nk.json`, `cacophony-nkpsk0.json`, `snow-nk.json` | upstream Noise vectors (source, license and retrieval date inside) | `noise.test.ts` |
| `agetor-noise.json` | Agetor: prologue, rekey, PSK failures | `noise.test.ts` |
| `rfc9180-base-x25519-chacha.json`, `agetor-push.json` | RFC 9180; Agetor push seal | `hpke.test.ts` |
| `agetor-messages.json`, `agetor-decision.json`, `agetor-qr.json` | Agetor | `messages.test.ts`, `decision.test.ts`, `qr.test.ts` |
