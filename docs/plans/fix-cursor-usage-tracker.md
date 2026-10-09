# Plan — Fix Cursor usage tracker 401

| Field | Value |
| --- | --- |
| Date | 2026-10-07 |
| Source | Screenshot of the Cursor usage card: `https://cursor.com/api/usage-summary returned 401` |
| Config | AGENTS_CONFIG.yml (legacy balanced preset; `/implement --update` would move it to schema v3 without changing models) |
| Flags | none |
| Gates | Grill questions skipped; owner approved the plan with the recommended answers |
| Branch | `fix/cursor-usage-tracker-bug` |
| Base SHA | `e55270a9bb9ad40553817e07adc9517cce83e70a` (tree dirty only by this untracked plan) |

## 1. Objective & success criteria

The Cursor usage card stops showing a raw HTTP URL when Cursor rejects the saved login. It tells the user to sign in to the Cursor app and click Refresh.

A saved login that Cursor will still refresh is used for that fetch, in memory only, so the meters return without a re-login. A login Cursor refuses to refresh (`shouldLogout`, empty token) stays an error with that sign-in sentence — it does not pretend the numbers are current.

After an error, the background poll keeps reading Cursor's local login. A later sign-in shows up on the next sweep. A machine that has never successfully read Cursor's login still does not touch that database in the background (the existing macOS permission guard).

On this machine, measured 2026-10-07: the stored access token expired 2026-10-06T17:46:18Z, `usage-summary` returns 401 `not_authenticated`, and refresh returns HTTP 200 with an empty `access_token` and `shouldLogout: true`. Shipping this plan will not paint meters here until the owner signs in to Cursor again. The card will show the sign-in sentence instead of the URL, and a later sign-in will be picked up without another code change.

## 2. Context & constraints

Grounded in the current tree and a local spike. No token, cookie, or user id was printed.

- The card body is `quota.reason`, rendered when there are no meters (`src/mainview/components/usage/UsagePopover.tsx`). The string is built in `fetchJson` as `` `${url} returned ${status}` `` (`src/bun/usage/cursor-usage.ts`, the non-OK branch) and stored by the `fetchCursorQuota` catch as `status: "error"`.
- The cookie is derived, not stored. `cursorAuth/accessToken` in `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` is a bare JWT. `deriveSessionCookieFromJwt` builds `WorkosCursorSessionToken=<userId>%3A%3A<jwt>`, where `userId` is the tail of `sub` after the last `|`. `cursorAuth/refreshToken` is never read. Browser-cookie import is a stub that returns null.
- `refreshOne` (`src/bun/usage/poller.ts`) allows that database read only when `force` is set or the previous snapshot's status is `"ok"`. A 401 overwrites the snapshot with `"error"`. The next background sweep then skips the read and replaces the card with "Cursor usage isn't read in the background…". A sign-in that lands a new token on disk is invisible until the user clicks Refresh.
- Spike (`/tmp/agetor-impl-cursor-usage/spikes/token-401/`, bun 1.3.10), read-only SQLite, sanitized output only:
  - Access token and refresh token both present (length 424, three JWT segments). `exp` 2026-10-06T17:46:18Z, about 30 hours in the past. `sub` prefix `google-oauth2`, user-id portion starts with `user_`.
  - `GET https://cursor.com/api/usage-summary` with both `%3A%3A` and `::` returned 401, body keys `error`, `description`, `error=not_authenticated`.
  - `POST https://api2.cursor.sh/oauth/token` with `{grant_type:"refresh_token", client_id, refresh_token}` returned 200, keys `access_token`, `id_token`, `shouldLogout`. `shouldLogout` is `true`. Both token strings are empty.
  - `client_id` used: `KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB` (public desktop client id in `eisbaw/cursor_api_demo`, `DEFAULT_AUTH_CLIENT_ID`). The endpoint accepted it (200, not `invalid_client`).
- Web research found no 2026 move of `usage-summary` and no cookie-format change. Community clients still send `WorkosCursorSessionToken`. Bearer auth is not accepted on `cursor.com/api/*`. Refresh is `POST https://api2.cursor.sh/oauth/token`; `shouldLogout: true` means sign in again.
- History: cookie derivation landed 2026-08-13 (`aee963b`); the TCC gate landed 2026-09-16 (`dbf9a59`). Refresh was never implemented. This branch has no commits of its own.
- CLI and TUI do not render `HarnessQuota`. The popover already prints `reason` verbatim, so the webview does not need a copy change.

## 3. Approach & key decisions

Try one refresh per fetch when the access token is expired or `usage-summary` returns 401, then map a still-failed 401 to a fixed sign-in sentence.

Alternatives considered:

- Message only, no refresh call. Smaller, but a user whose refresh token still works would keep seeing the sign-in sentence until they re-login for no reason. Refresh is one request and the spike proved the endpoint answers. Chosen: try refresh.
- Keep the last good meters and mark them stale. The owner skipped the question; the recommended option is to drop the meters. Stale percentages after a rejected login read as current.
- Write the refreshed access token back into `state.vscdb` or into agetor's SQLite. Rejected. Agetor already reads that file; writing it can race the IDE, and copying the refresh token into our database stores a credential we do not need. The new access token lives only for that fetch.

Decisions that rest on the spike: the 401 on this machine is an expired access token, not a wrong `%3A%3A` encoding; refresh with that client id is a real Cursor endpoint; empty tokens plus `shouldLogout: true` means we must not retry `usage-summary` with a blank token.

`allowIdeRead` becomes true when the previous snapshot is `"ok"` or `"error"`, or when the user forced a refresh. `"unavailable"` stays closed. `"error"` is only produced after a cookie was found (the skip path writes `"unavailable"`), so an error row is evidence the database was already read once. This keeps the TCC cold-start guard and stops a 401 from permanently disarming the poll.

401 copy, exact string, used for both an expired token that will not refresh and a non-expired token that still 401s:

`Cursor's saved login expired or was rejected. Open the Cursor app and sign in again, then click Refresh — Agetor reads Cursor's local login to fetch plan usage.`

Other failures (timeout, 5xx) keep today's short error text. Do not put the request URL in the 401 reason.

## 4. Work breakdown — implementation tasks

### I1 — Recover or explain a rejected Cursor login

Owns:

- `src/bun/usage/cursor-usage.ts`
- `src/bun/usage/poller.ts`

Depends on: nothing.

Acceptance:

- Read `cursorAuth/accessToken` and `cursorAuth/refreshToken` with the existing key-indexed, read-only SQLite query. Do not scan values. Do not log either token.
- Export nothing new that returns a raw token. Pure helpers that take a JWT string and return a boolean, an expiry, or the derived cookie may be exported for tests if they do not read the database.
- When the access token's `exp` is at or before now, or `usage-summary` returns 401, POST the refresh token once to `https://api2.cursor.sh/oauth/token` with the client id in §2, `grant_type: "refresh_token"`, JSON body, 5s timeout (same budget as the usage fetch).
- A non-empty JWT `access_token` is derived into a cookie the same way as today and the usage fetch (and `auth/me`) is retried once. The new token is not written anywhere.
- `shouldLogout: true`, an empty `access_token`, a non-JWT, or a refresh HTTP failure does not retry with an empty cookie. A 401 after that, or a 401 when there is no refresh token, resolves `status: "error"`, `meters: []`, `planType: null`, and the sign-in sentence in §3.
- `refreshOne` passes `allowIdeRead: true` when the stored snapshot status is `"ok"` or `"error"`, and still `false` when it is missing or `"unavailable"`, unless `force` is set. Update the comment that currently says `"ok"` is the only proof, so it states why `"error"` counts and why `"unavailable"` does not.
- No change to `UsagePopover.tsx`, the API routes, or the database schema.

## 5. Work breakdown — test tasks

### T1 — Lock the 401 recovery and the poller gate

Owns:

- `src/bun/usage/cursor-usage.test.ts`
- `src/bun/usage/poller.test.ts`

Depends on: I1.

Acceptance:

- Synthetic unsigned JWTs only (tests mint `header.payload.sig` with a fake `sub` and `exp`). No real token, no network.
- Inject the session and `fetch` through optional arguments on `fetchCursorQuota` (production callers omit them). Restore any global mock.
- Expired access token + refresh that returns a new JWT → `usage-summary` is called with a `WorkosCursorSessionToken` cookie derived from the new JWT, and a fixture body parses to `status: "ok"`.
- Expired access token + refresh body `{access_token:"", id_token:"", shouldLogout:true}` → no `usage-summary` retry, `status: "error"`, reason equals the §3 sentence, and the refresh token never appears in the reason.
- Non-expired token + `usage-summary` 401 + no refresh token → same sentence, one usage request.
- `usage-summary` 500 → reason is not the sign-in sentence (today's error text stays).
- `refreshOne` with a prior `status: "error"` snapshot passes `allowIdeRead: true`. The existing unavailable-snapshot test still expects `false`.

E2e: not applicable to the auth behavior. It would need a live Cursor login and `cursor.com`. The popover already renders `quota.reason` with no component change, and `e2e/usage-tracker.spec.ts` seeds snapshots rather than calling Cursor. Unit tests are the coverage for this change.

Run recipe for Phase 7: `bun test src/bun/usage/cursor-usage.test.ts src/bun/usage/poller.test.ts`, then `bun run typecheck`. Full `bun test` if the targeted run is green.

## 6. Execution waves

Wave 1: I1 (one agent, both source files — the poller comment and the fetcher are one behavior).

Barrier.

Wave 2: T1 (one agent, both test files).

Review runs on the Wave 1 diff before tests are written, per the implement sequence. Must-fixes land with the test fixes if review and tests overlap.

## 7. Blast radius & risks

- Callers of `fetchCursorQuota`: `USAGE_PROVIDERS` in `poller.ts`, and tests. `POST /harnesses/:id/usage/refresh` calls `refreshOne` with `force: true`, so a manual Refresh still reads the database.
- A background sweep will POST the refresh endpoint at most once per Cursor harness per sweep (10 minutes) while the login stays rejected. That is the cost of noticing a new sign-in. Do not cache `shouldLogout` across process restarts; the access token on disk is the signal.
- The OAuth client id is a published desktop id, not a user secret. If Cursor rotates it, refresh fails closed into the sign-in sentence. Same failure mode as today, with clearer copy.
- Rollback: revert the two source files. No migration.
- Out of scope, pre-existing: `cursorStateDbPath()` ignores `harness.home`, so an additional Cursor account is not read. Browser cookie import stays stubbed. CLI/TUI still have no usage card.

## 8. Open questions / assumptions

The owner skipped the grill. These are the recommended answers, not confirmed choices. Confidence is high where the spike measured the machine, and medium where the choice is product taste.

| Question | Answer used | Source | Confidence |
| --- | --- | --- | --- |
| What does this machine's 401 mean? | Expired access token. Both cookie encodings 401. Refresh returns empty tokens and `shouldLogout: true`. | Spike, 2026-10-07, bun 1.3.10 | High |
| Try refresh, or only change the sentence? | Try refresh once. Sign-in sentence when Cursor will not issue a token. | Recommended; grill skipped | Medium — a message-only change would also clear the screenshot |
| Last good meters? | Replace them. The chip must not keep numbers after a rejected login. | Recommended; grill skipped | Medium |
| Background read after an error? | Keep reading. `"unavailable"` still does not open the read. | Code: skip path writes `unavailable`; error requires a cookie. Grill skipped | High on the TCC invariant; medium on whether the owner wants the extra refresh POST |
| Write tokens to disk? | No. | Reversible and safer | High |
| Will meters return on this machine without a sign-in? | No. | Spike `shouldLogout: true` | High |

## 9. Completeness ledger

| Candidate | Disposition |
| --- | --- |
| 401 path in `fetchJson` / `fetchCursorQuota` | In this run — I1 |
| `refreshOne` IDE-read gate after `error` | In this run — I1 |
| Sign-in sentence rendered by the existing popover | In this run — no UI edit; the reason string is the UI |
| Unit tests for refresh success, `shouldLogout`, 401 without a refresh token, 500, and the error-snapshot gate | In this run — T1 |
| Poller comment that says only `"ok"` proves consent | In this run — I1 (the comment would be false after the gate change) |
| Browser cookie import | Out of scope — different ticket; v1 stub, plan `harness-usage-tracker.md` already excludes it |
| Additional-account Cursor `harness.home` | Out of scope — pre-existing; the database path is hardcoded and this bug is the built-in login |
| CLI/TUI usage card | Out of scope — those surfaces never render `HarnessQuota` |
| Persisting a refreshed token into `state.vscdb` or `harness_usage` | Out of scope — would store a credential and race the IDE |
| E2e against `cursor.com` | Out of scope — not deterministic; see §5 |
