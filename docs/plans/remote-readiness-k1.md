# K1V — live verification of the key helper (owner-gated)

**Status: NOT RUN.** This verification needs the owner's Apple Developer App ID (`sh.alamops.agetor.keyhelper`) and a Developer ID provisioning profile for it (grill D2), and a Mac with a Secure Enclave. Nothing in this change could do it unattended, so it is recorded here as owner work, not as a result. The helper's source, its build script, its self-test and every TypeScript-side check are in the change and green; what is unproven is the one thing only real signing can prove: that the data-protection keychain item is created under the access group and that nothing but the helper can read it.

**If step 1 fails, stop.** Grill D3 removed the login-keychain fallback, so pairing would be impossible and the owner must re-decide (plan §8).

## Prerequisites (owner)

- The App ID `sh.alamops.agetor.keyhelper` with the Keychain Sharing capability, and a Developer ID provisioning profile for it, saved OUTSIDE the repository. `*.provisionprofile` is gitignored.
- `ELECTROBUN_DEVELOPER_ID` set to the Developer ID Application identity of the same team (`.env.local`).
- An Apple-silicon Mac (macOS 26.6.2 is the version the plan names) with a Touch ID sensor.

## Steps and what each must print

1. Build and self-test the helper with the profile:

   ```sh
   AGETOR_KEYHELPER_PROFILE=<path to the profile> bun scripts/build-keyhelper.ts
   vendor/keyhelper/AgetorKeyHelper.app/Contents/MacOS/keyhelper selftest
   ```

   Must show: the Secure Enclave is available; the data-protection item was created under the access group `<TEAM>.sh.alamops.agetor.keyhelper`. Then, from Bun (a different process), `security find-generic-password -l <the item's label>` must NOT be able to read the core key.
2. `bun run release:build-only` (or `bun run build`) passes `scripts/verify-release.ts`: the helper at `Contents/Resources/app/bin/AgetorKeyHelper.app`, a valid signature, the profile embedded, the profile's team equal to the signature's, the `keychain-access-groups` entitlement, and (a dark release) no Companion marker or test seam in the shipped JS.
3. Against `~/.agetor-dev` (never `~/.agetor`) with `AGETOR_E2E_HARNESS_SEAMS=1` and `AGETOR_REMOTE_RELAY_URL` at a local test relay (`packages/remote-protocol/src/test-relay.ts`): a headless phone (`test-client.ts`) pairs with the REAL helper (the native window, a typed code, Touch ID, a level choice), connects and reads the board.
4. Revoke from Settings › Remote access closes that phone's session within one second.

## Record (fill in when run)

| Step | macOS | Command | Output | Result |
|---|---|---|---|---|
| 1 | | | | |
| 2 | | | | |
| 3 | | | | |
| 4 | | | | |

What the unattended work already established: the helper builds ad hoc on a Mac with `swiftc`, passes `selftest-vectors` against the SAS, canonical-JSON and QR vectors (`scripts/build-keyhelper.test.ts`), and the TypeScript client drives a process speaking its JSON-lines protocol (`src/bun/remote/key-helper.test.ts`). An ad-hoc helper cannot use the data-protection keychain: its keychain operations fail with `keychain-unavailable` and the gateway refuses to pair, which is the intended fail-closed behavior.
