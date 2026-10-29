# Companion pairing: requirements the core must keep

| Field | Value |
| --- | --- |
| Date | 2026-10-27 |
| Source | `docs/plans/master-token-agent-read-grill.md` D14, D15, G5; `docs/plans/master-token-agent-read.md` TT3(c) |
| Status | Requirements only. Nothing here is built; there is no Companion app to pair with yet. |

The Companion phone app will need three things Agetor does not have today: pairing a device, turning on remote access, and giving a paired device more permissions. This note records the rules those features must follow, so the HTTP API doesn't grow a way around them in the meantime.

## Why these rules exist

Any program running as the user can read files in `~/.agetor`, write the SQLite database, and run Agetor's own signed binaries. Agents are such programs. So nothing stored on disk can prove that the user approved something, and a Keychain item doesn't change that: Keychain access checks the calling binary's code signature, and an agent can run Agetor's signed `bun` with a script of its own and pass that check (grill G5, reasoned, not run as a spike). Only the user being present at the Mac can make a stored value trustworthy.

The CLI token in `agetor-core.json` is readable by agents on purpose (it does what the CLI does). The app's master token is in memory only. Whatever Companion adds must not be reachable with the CLI token, and must not depend on a secret an agent could also read.

## Rules

1. **Pairing, enabling remote access and raising a device's permissions are native-only.** They happen in a Swift helper or an Electrobun RPC window. Never over HTTP, and never in the webview: a compromised webview holds the master token, so the webview is not a place to approve a new device.
2. **The code is shown on the phone and typed on the Mac.** The user reads the code on the device being paired and enters it in the native window on the Mac. A code displayed on the Mac and typed on the phone could be read by anything that can read the screen or the app's memory, and typing it on the phone proves nothing about who is at the Mac.
3. **Revoking a device and disabling remote access may be HTTP or CLI.** They only remove authority, so an agent that triggers them can at worst inconvenience the user.
4. **The device registry needs the user present to stay trustworthy.** A registry file protected by a Keychain MAC alone can be rewritten by an agent (G5). Adding a device, or changing a device's level, must go through a step the user performs at the Mac (the native window above); the registry's integrity can't rest on a stored secret.
5. **No HTTP route, in any scope, pairs, lists-and-edits devices, toggles remote access or changes a permission level.** `src/bun/route-policy.test.ts` (TT3(c)) fails on any route path with a segment named `pair`, `pairing`, `device`, `devices`, `remote` or `remote-access`, and on any route ending in `permission` or `permissions` other than the two allowlisted ones (`/fx-permissions/:id/answer`, which grants nothing to a client, and the read-only `/github/repo-permissions`). A route that really needs one of those words must change that test in the same change, which is where the review happens.

## Where Companion levels go

Every `ROUTE_POLICY` entry (`src/bun/route-policy.ts`) already carries `remote: "none"`. That field is where Companion's remote levels are added (for example read-only, answer prompts, drive tasks), so remote reach is decided per route in the same table, deny by default, and the "every route has an entry" startup check applies to it. A route stays `remote: "none"` until someone chooses a level for it.

## Out of scope here

The pairing UI, the device registry format, the transport (relay or direct) and the permission levels themselves. This note only fixes who is allowed to approve what.
