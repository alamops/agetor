# @agetor/remote-protocol

The Agetor Companion protocol as the desktop core implements it, plus the test tools that prove it.
Contract: `docs/specs/remote-readiness-spec.md` (as amended by the grill) and `docs/specs/remote-relay-contract.md`.

- `src/` primitives: `levels`, `constants`, `bytes`, `canonical-json` (RFC 8785), `es256` (raw r‖s, `lowS:false`),
  `derive` (mailbox keys and ids, pairing code, collapse id), `padding`, `relay-frames`, `envelope`.
  Later waves add `noise`, `hpke`, `push-payload`, `messages`, `decision`, `qr`, the local `test-relay` and the headless `test-client`.
- `vectors/` language-neutral JSON vectors. The Swift and Kotlin implementations must pass the same files.
  `bun scripts/gen-vectors.ts` rewrites the ones this package owns; `src/vectors.test.ts` fails when they drift.
- `schemas/` JSON Schemas for every message a phone reads.

The package is a Bun workspace member and is imported by path (`@agetor/remote-protocol/levels`): its single export is `./*` → `./src/*.ts`.
The test relay and test client are never imported from `src/`.

```sh
cd packages/remote-protocol && bun test
```
