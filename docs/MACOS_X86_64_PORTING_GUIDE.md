# Agetor macOS x86_64 (Intel) Porting & Setup Guide

This guide documents how Agetor was ported to support Intel-based macOS (`x86_64`) alongside Apple Silicon (`arm64`), the architectural lessons learned, and how to build and run Agetor on an Intel Mac.

> **Implementation Note:** This multi-architecture support was developed and verified with **Gemini 3.8 Flash (High effort)**.

---

## 1. Architectural Overview

Agetor combines:
- **Electrobun:** Desktop shell handling native windows and webview rendering.
- **Bun:** Backend runtime hosting SQLite migrations, API server, and task orchestration.
- **Vite & React:** Frontend Kanban interface.
- **Native Helper Binaries:**
  1. `tmux`: Terminal multiplexer managing long-running agent sessions.
  2. `AgetorNotifier.app`: Native Swift helper posting click-to-open notifications via `UNUserNotificationCenter`.
  3. `disclaim`: Lightweight C POSIX spawn helper resetting TCC responsibility for spawned agent child processes.

### Why was Agetor initially arm64-only?
The upstream maintainers ship release DMGs for Apple Silicon (`arm64`) only. Consequently, build scripts enforced `process.arch !== "arm64"` assertions and hardcoded `vendor/tmux/arm64` paths. However, the core dependencies (Bun, Electrobun, Clang, Swift) all have full native support for macOS `x86_64`.

---

## 2. Prerequisites for Intel Mac

To build and run on Intel macOS:
1. **macOS 13+ (Ventura, Sonoma, or Sequoia)**
2. **Bun:** `curl -fsSL https://bun.sh/install | bash` (>= 1.3)
3. **Homebrew & tmux:**
   ```bash
   brew install tmux
   ```
   *(On Intel Macs, Homebrew binaries reside in `/usr/local/bin` and libraries in `/usr/local/opt/`.)*
4. **Xcode Command Line Tools:**
   ```bash
   xcode-select --install
   ```
   *(Required for `clang`, `swiftc`, `codesign`, and `lipo`.)*

---

## 3. Key Changes Made

### 1. `scripts/fetch-tmux.ts`
- Changed `const ARCH = "arm64";` to `const ARCH = process.arch;`.
- Replaced the `arm64`-only guard with `if (process.arch !== "arm64" && process.arch !== "x64")`.
- Copies `/usr/local/bin/tmux` and brew dylibs (`utf8proc`, `ncursesw`, `libevent_core`) to `vendor/tmux/x64/` and patches `@executable_path` load commands with `install_name_tool`.

### 2. `scripts/build-notifier.ts`
- Added support for `x64` in host checks.
- Set compilation target dynamically: `const target = process.arch === "x64" ? "x86_64-apple-macos13" : "arm64-apple-macos13";`.
- Dynamically validates Mach-O architecture with `lipo -archs`.

### 3. `scripts/build-disclaim.ts`
- Added support for `x64` in host checks.
- Passed `-arch x86_64` when `process.arch === "x64"` (and `-arch arm64` on Apple Silicon).
- Validated binary architecture with `lipo`.

### 4. `src/bun/tmux-resolution.ts`
- Updated `bundledTmuxPath()` to inspect `vendor/tmux/${process.arch}/tmux` before the `arm64` fallback.

### 5. `electrobun.config.ts`
- Updated `build.copy` mapping to copy dynamically: `[`vendor/tmux/${process.arch}`]: "bin"`.

---

## 4. Build & Run Sequence

To build and run the application locally on an Intel Mac:

```bash
# 1. Install dependencies
bun install

# 2. Vendor local tmux and dependencies
bun run vendor:tmux

# 3. Compile notification helper (AgetorNotifier.app)
bun run vendor:notifier

# 4. Compile TCC spawn helper (disclaim)
bun run vendor:disclaim

# 5. Verify vendor binary signatures
bun run verify:vendor

# 6. Typecheck TypeScript sources
bun run typecheck

# 7. Build desktop app and frontend
bun run build

# 8. Start development server with live reload (HMR)
bun run dev:hmr
```

---

## 5. Technical Lessons & Gotchas

1. **Electrobun Core Dependencies:**
   When running `electrobun build` or `electrobun dev` on an Intel Mac, Electrobun automatically detects `macos-x64` and downloads `electrobun-core-darwin-x64.tar.gz`. No manual build of zig/electrobun core is necessary.
2. **Inside-Out Code Signing:**
   macOS enforces code signing for all Mach-O binaries loading dylibs or spawning processes. Electrobun does not recursively re-sign files copied under `Contents/Resources/app/bin/`. Thus, the vendor scripts must sign them inside-out before packaging. Ad-hoc signing (`codesign --force --sign -`) is sufficient for local development.
3. **Homebrew Cellar Resolution:**
   `isBrewPath()` in `scripts/fetch-tmux.ts` already supported `/usr/local/opt/` and `/usr/local/Cellar/` alongside `/opt/homebrew/`. Making `ARCH` dynamic immediately allowed Intel Homebrew libraries to be relocated seamlessly.
