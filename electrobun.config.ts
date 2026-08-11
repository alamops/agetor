import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "Agetor",
    identifier: "sh.alamops.agetor",
    version: "0.1.0",
    // Registers agetor:// so a clicked terminal-notifier notification's
    // `-open agetor://task/<id>` (see src/bun/notifier.ts) routes back into
    // this app as an "open-url" event, which src/bun/deep-link.ts parses
    // back into a task id. Hardcoded rather than imported from
    // src/bun/deep-link.ts (APP_URL_SCHEME) to keep this build-config file
    // free of app-source imports — keep the two in sync by hand.
    urlSchemes: ["agetor"],
  },
  release: {
    // GitHub Releases' "latest" download URL — always redirects to the most
    // recent non-prerelease tag. `electrobun build` bakes this into
    // Resources/version.json, and Updater.checkForUpdate() fetches
    // <baseUrl>/<channel>-macos-arm64-update.json from there. Filenames stay
    // identical across releases so the redirect resolves cleanly each time.
    baseUrl: "https://github.com/alamops/agetor/releases/latest/download",
    // Delta patches carry forward old-hash → new-hash diffs; turning them on
    // means scripts/upload-release.ts must also reupload previous releases'
    // .patch files into the new release (GitHub's "latest" URL only serves
    // assets from the current tag). Disabled until we want to pay that
    // complexity for ~4 KB updates instead of ~5–30 MB full bundles.
    generatePatch: false,
  },
  runtime: {
    // Don't quit the bun process when the user closes the window. Agetor
    // hosts long-running claude/codex sessions in tmux that should survive
    // a dismissed window — the user can bring the window back via the Dock
    // icon (handled by the `reopen` event in src/bun/index.ts). Cmd+Q is
    // the explicit quit path and goes through the `before-quit` confirm
    // dialog in quit-guard.ts.
    exitOnLastWindowClosed: false,
  },
  build: {
    copy: {
      "dist/index.html": "views/mainview/index.html",
      "dist/assets": "views/mainview/assets",
      // Boot splash logo. Source straight from src/mainview/public/ rather
      // than dist/ — Vite only writes the file to dist/ during `vite build`,
      // so when `bun run dev:hmr` runs the electrobun copy step before any
      // production build has happened, dist/splash-logo.png doesn't exist
      // and electrobun aborts. The source path always exists.
      "src/mainview/public/splash-logo.png": "views/mainview/splash-logo.png",
      // Bundled tmux for users without one on PATH — see scripts/fetch-tmux.ts.
      // Lands at Contents/Resources/app/bin/ inside the .app, which is what
      // src/bun/tmux-resolution.ts:bundledTmuxPath() points to at runtime.
      "vendor/tmux/arm64": "bin",
      // Our own native arm64 notifier helper (AgetorNotifier.app) — posts
      // deep-linkable notifications via UNUserNotificationCenter and opens
      // agetor://task/<id> on click (built by scripts/build-notifier.ts from
      // native/notifier/). Lands at Contents/Resources/app/bin/
      // AgetorNotifier.app; src/bun/notifier.ts:resolveNotifier() points at its
      // inner executable. No third-party binary, no Rosetta. The agetor://
      // scheme registered above is what the click routes back through.
      "vendor/notifier": "bin",
    },
    watchIgnore: ["dist/**", ".agetor/**", "vendor/**"],
    mac: {
      bundleCEF: false,
      icons: "src/assets/agetor.iconset",
      codesign: true,
      notarize: true,
    },
    linux: { bundleCEF: false, icon: "src/assets/agetor-icon.png" },
    win: { bundleCEF: false, icon: "src/assets/agetor-icon.ico" },
  },
} satisfies ElectrobunConfig;
