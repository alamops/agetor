import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "Agetor",
    identifier: "sh.alamops.agetor",
    version: "0.0.10",
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
