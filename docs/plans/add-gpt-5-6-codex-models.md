# Plan - Add GPT-5.6 Codex Models
| Field | Value |
| --- | --- |
| Date | 2026-08-06 |
| Source | `/implement OpenAI release GPT 5.6 Sol, Terra and Luna` |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | fix/add-gpt-5-6 |
| Base SHA | 4b9328fb64dfdc70e7208ceed89fa26807d82240 |

## 1. Objective & success criteria

Add `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna` to Agetor's Codex model picker, and make `gpt-5.6-sol` the default Codex model for new tasks.

Success means the UI/CLI default model path resolves Codex to `gpt-5.6-sol`, the picker exposes all three GPT-5.6 variants, supported effort filtering matches official GPT-5.6 guidance, and Codex command construction passes the selected GPT-5.6 model ID through unchanged.

## 2. Context & constraints

Official OpenAI documentation says `gpt-5.6` routes to `gpt-5.6-sol`, and names `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna` as the GPT-5.6 family. The same guidance lists GPT-5.6 reasoning efforts from `none` through `max`.

Local findings:

- `src/shared/types.ts` owns `DEFAULT_MODEL`, `MODEL_EFFORT_SUPPORT`, and `AGENT_OPTIONS`.
- `src/bun/agents.ts` passes Codex model IDs through as `--model <id>` and maps effort to `-c model_reasoning_effort=<id>`.
- `src/bun/effort-support.test.ts` covers effort filtering and default-model fallback.
- `src/bun/agents.test.ts` covers Codex command construction.

## 3. Approach & key decisions

Use the exact model IDs rather than the `gpt-5.6` alias so the user-visible default is explicitly Sol. Keep legacy GPT-5.5/GPT-5/GPT-5 Codex options available rather than removing historical choices.

Add `none` and `max` effort support only for the GPT-5.6 family, leaving older Codex models on their existing `low` to `xhigh` range.

## 4. Work breakdown - implementation tasks

Task 1: Update Codex model registry.

- Owns: `src/shared/types.ts`
- Acceptance: Codex default is `gpt-5.6-sol`; all three GPT-5.6 model options are present; GPT-5.6 efforts include `max` and `none`.

Task 2: Update docs copy.

- Owns: `README.md`
- Acceptance: model examples mention GPT-5.6 Sol/Terra/Luna for Codex.

## 5. Work breakdown - test tasks

Task 3: Update focused unit tests.

- Owns: `src/bun/effort-support.test.ts`, `src/bun/agents.test.ts`
- Acceptance: tests cover Codex default, GPT-5.6 effort support, unknown-model fallback to Sol support, and command pass-through for `gpt-5.6-sol`.

E2E does not apply: this is a shared registry/default change with no new user flow or process boundary beyond already-tested command construction.

## 6. Execution waves

One local wave: update registry/docs/tests together because the change is small and centered on one shared file.

## 7. Blast radius & risks

New tasks default to `gpt-5.6-sol` for Codex. Existing tasks keep their persisted model unless edited. Legacy null model rows are backfilled by current default paths, so Codex legacy rows will move to Sol when the app applies defaulting behavior.

Risk: if a user's installed Codex CLI predates GPT-5.6 support, launching the new default may fail at the CLI. The existing app already supports discovered models and direct model pass-through; this change follows that established pattern.

## 8. Open questions / assumptions

No open product questions. Assumption: Agetor should expose all three new Codex choices while preserving older Codex models for compatibility.
