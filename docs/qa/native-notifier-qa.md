# Manual QA — native notifier helper (notification click → task modal)

Everything except the notarized/OS-integration behavior is verified automatically
(`bun run typecheck` + `bun test` green; helper compiles + ad-hoc-signs arm64).
This checklist covers what can only be confirmed on a real, signed build.

## Build
```bash
export ELECTROBUN_DEVELOPER_ID="Developer ID Application: A&A GLOBAL INTERNATIONAL LLC (ZQG3522LY7)"
bun run build     # runs vendor:notifier (builds+signs AgetorNotifier.app), then electrobun build + notarize
```

- [ ] **Notarization accepts the nested bundle.** The build completes without a
      codesign/notarytool rejection mentioning `AgetorNotifier.app`. (If it
      fails: confirm the helper is signed hardened-runtime *before* Electrobun
      signs the outer app — sign inside-out. `codesign -dv --deep --strict
      <agetor.app>` should show both signatures valid.)
- [ ] Inside the built app: `<Agetor.app>/Contents/Resources/app/bin/AgetorNotifier.app`
      exists and `codesign --verify --strict` passes; `lipo -archs` on its inner
      binary is `arm64` only.

## First-run permission
- [ ] Launch the built Agetor. Trigger a task notification (finish a run while
      the Agetor window is **unfocused**).
- [ ] A one-time **"Agetor" would like to send notifications** prompt appears →
      click **Allow**.
- [ ] The notification banner shows, branded **Agetor** (icon + name), with the
      task title/subtitle.

## The core loop (the [high] item from review)
- [ ] Let the helper fully exit (it self-exits after posting). Then **click the
      banner** → Agetor comes to the foreground and the **RunPanel opens for that
      exact task**.
- [ ] Repeat with the Agetor **window closed** (Cmd-W, process still running):
      click a notification → window is recreated + the task opens.
- [ ] **Cold path:** Cmd-Q Agetor entirely, then click an older Agetor
      notification still in Notification Center → Agetor launches and the task
      opens once booted.

> If the click does **nothing** (banner dismisses, no task opens): the
> directly-exec'd helper wasn't relaunchable by LaunchServices. Startup already
> runs `lsregister -f` on it as a mitigation; if it still fails, switch to the
> pre-scoped **stay-alive-until-click** helper variant (keep the helper process
> alive with a timeout instead of relying on relaunch). Tell me and I'll wire it.

## Edge cases
- [ ] **Deny** the permission prompt on a fresh machine → notifications simply
      don't appear (by design we do NOT fall back to a second "Agetor" identity
      that would re-prompt). Re-enable in System Settings › Notifications › Agetor.
- [ ] `--silent` path: a notification posted with `silent: true` shows without a
      sound (both background and if Agetor is frontmost).
- [ ] Only **one** extra "Agetor" row appears in System Settings › Notifications
      (the helper's). The plain `Utils.showNotification` fallback only fires when
      the helper is missing or crashes (not on denial), so no duplicate identity
      under normal use.

## Not needed on this machine
- Dev runs (`bun run dev`) resolve the helper from `vendor/notifier/` after
  `bun run vendor:notifier`; the `agetor://` scheme only routes once the built
  `.app` is registered with LaunchServices, so the full click loop is a
  built-app test, not a dev-server test.
