export interface PlatformNavigator {
  platform?: string;
  userAgent?: string;
}

/**
 * The single platform sniff every keyboard-shortcut handler uses to pick
 * `metaKey` (macOS) vs `ctrlKey` (elsewhere). Agetor packages arm64 macOS
 * only, but the Vite dev webview can run in any browser, so it still
 * branches. `nav` is injectable so tests don't depend on Bun's own
 * `navigator` (which reports "MacIntel" under `bun test`).
 */
export function isMacPlatform(
  nav: PlatformNavigator | undefined = typeof navigator !== "undefined" ? navigator : undefined,
): boolean {
  if (!nav) return false;
  return /mac/i.test(nav.platform || nav.userAgent || "");
}
