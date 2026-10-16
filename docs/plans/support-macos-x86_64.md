# Plan — Support macOS x86_64 (Intel) alongside arm64

| Field | Value |
| --- | --- |
| Date | 2026-10-01 |
| Author | Community PR via `@dxrkxr` |
| AI Model | Gemini 3.8 Flash (effort=high) |
| Target | macOS x86_64 (Intel) and arm64 (Apple Silicon) |
| Status | Implemented & Verified |

## 1. Objective & Background

### Context
Agetor is designed as a local agent orchestrator with desktop packaging via Electrobun and Bun. Originally, the build chain and runtime resolvers hardcoded `arm64` assumptions (`ARCH = "arm64"`, `process.arch !== "arm64"` assertions, and hardcoded `vendor/tmux/arm64` directory mappings). This prevented developers on Intel-based Macs (`x86_64`) from building or developing locally.

### Objective
Enable complete, seamless development and execution of Agetor on macOS `x86_64` (Intel) while maintaining 100% backward compatibility with `arm64`.

---

## 2. Technical Stack & Implementation Details

This port was engineered and verified using:
- **Gemini 3.8 Flash (High effort):** Guided systematic debugging, code analysis, compiler targeting, and end-to-end verification.
- **Bun (1.4+):** Executes the backend server, runs SQLite migrations, and provides native test execution on both `x86_64` and `arm64`.
- **Electrobun (1.18+):** Desktop webview shell. Automatically downloads and unpacks official `electrobun-core-darwin-x64` binaries on Intel hosts.
- **Apple Clang (`clang`):** Compiles the POSIX spawn helper `disclaim` with dynamic architecture selection (`-arch x86_64` on Intel, `-arch arm64` on Apple Silicon).
- **Apple Swift (`swiftc`):** Compiles `AgetorNotifier.app` using `xcrun swiftc` with dynamic SDK target (`-target x86_64-apple-macos13` on Intel, `-target arm64-apple-macos13` on Apple Silicon).
- **macOS `install_name_tool` & `otool`:** Rewrites Homebrew dylib dependencies (`utf8proc`, `ncursesw`, `libevent_core`) to `@executable_path/` references. Note that `isBrewPath()` already recognized `/usr/local/opt/` and `/usr/local/Cellar/` (standard Intel Homebrew locations).
- **Inside-Out Code Signing (`codesign`):** Signs nested binaries (`tmux`, `disclaim`, `AgetorNotifier.app`) ad-hoc (`codesign -s -`) for local runs or via Developer ID (`ELECTROBUN_DEVELOPER_ID`) for notarized releases.

---

## 3. Architecture & File Changes

1. **`scripts/fetch-tmux.ts`**
   - Removed the strict `process.arch !== "arm64"` assertion; allowed both `"arm64"` and `"x64"`.
   - Set `const ARCH = process.arch;` so vendored tmux and dylibs are stored in `vendor/tmux/${process.arch}/`.

2. **`scripts/build-notifier.ts`**
   - Allowed both `"arm64"` and `"x64"`.
   - Targeted `x86_64-apple-macos13` when `process.arch === "x64"`.
   - Updated `lipo -archs` verification to check for `x86_64` dynamically.

3. **`scripts/build-disclaim.ts`**
   - Allowed both `"arm64"` and `"x64"`.
   - Passed `-arch x86_64` when compiling on Intel.
   - Updated `lipo -archs` verification to validate against host architecture.

4. **`src/bun/tmux-resolution.ts`**
   - Updated `bundledTmuxPath()` to search `vendor/tmux/${process.arch}/tmux` before falling back to `vendor/tmux/arm64/tmux`.

5. **`electrobun.config.ts`**
   - Updated `build.copy` mapping dynamically: `[`vendor/tmux/${process.arch}`]: "bin"`.

6. **`src/bun/tmux-resolution.test.ts`**
   - Added unit test asserting `bundledTmuxPath()` correctly resolves the current architecture's dev tmux binary.

---

## 4. Verification & Testing

All verification steps were performed directly on an Intel MacBook Pro (`x86_64`, macOS Sequoia 15.7.7):
- **Vendor Compilation:** `bun run vendor:tmux`, `bun run vendor:notifier`, `bun run vendor:disclaim` all completed with exit code 0.
- **Signing Verification:** `bun run verify:vendor` passed cleanly.
- **TypeScript Check:** `bun run typecheck` (`tsc --noEmit`) clean with zero errors.
- **Unit Tests:** `bun test src/bun/tmux-resolution.test.ts` passed (14/14 tests).
- **Application Build:** `bun run build` successfully packaged `build/dev-macos-x64/Agetor-dev.app`.
- **Runtime Execution:** `bun run dev` launched successfully: SQLite migrations applied, API initialized on port 4318, and the Electrobun main window rendered cleanly.
