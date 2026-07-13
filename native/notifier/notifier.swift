// AgetorNotifier — a tiny agent (LSUIElement) app that posts a deep-linkable
// macOS notification via UNUserNotificationCenter and, when the notification is
// clicked, opens the `agetor://task/<id>` URL carried in its userInfo.
//
// Why a separate helper at all: Electrobun's Utils.showNotification has no click
// callback, and UNUserNotificationCenter must run inside a signed .app bundle
// with its own bundle id (it does not work from a bare CLI). So agetor spawns
// this helper to post; the helper exits immediately (fire-and-forget). When the
// user clicks the banner, macOS RELAUNCHES this helper to deliver the response,
// its delegate runs `open agetor://task/<id>`, and LaunchServices routes that
// to the already-running agetor instance (its registered agetor:// handler),
// firing agetor's existing open-url -> open_task -> RunPanel flow.
//
// CLI contract (invoked by src/bun/notifier.ts buildNotifierArgs):
//   notifier --title <t> [--subtitle <s>] --message <m> [--url <agetor://...>] [--silent]
//
// arm64-only, no third-party dependency, no Rosetta. Build: swiftc against
// AppKit + UserNotifications (see scripts/build-notifier.ts).

import AppKit
import Foundation
import UserNotifications

struct Options {
  var title: String?
  var subtitle: String?
  var message: String = ""
  var url: String?
  var silent: Bool = false

  /// Post mode iff a title was supplied. A click-relaunch carries no args, so
  /// hasContent is false and we simply wait for the delegate callback.
  var hasContent: Bool { title != nil }
}

func parseArgs(_ argv: [String]) -> Options {
  var o = Options()
  var i = 1
  while i < argv.count {
    let flag = argv[i]
    let value: String? = i + 1 < argv.count ? argv[i + 1] : nil
    switch flag {
    case "--title": o.title = value; i += 2
    case "--subtitle": o.subtitle = value; i += 2
    case "--message": o.message = value ?? ""; i += 2
    case "--url": o.url = value; i += 2
    case "--silent": o.silent = true; i += 1
    default: i += 1
    }
  }
  return o
}

final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
  private let opts: Options

  init(_ opts: Options) { self.opts = opts }

  func applicationDidFinishLaunching(_ note: Notification) {
    let center = UNUserNotificationCenter.current()
    // Assign the delegate BEFORE launch completes so a click-relaunch delivers
    // its response to didReceive (Apple's documented requirement).
    center.delegate = self

    if opts.hasContent {
      postNotification(center)
    } else {
      // Relaunched only to deliver a click response; keep the run loop alive
      // briefly for didReceive, then exit as a safety net.
      scheduleExit(after: 10)
    }
  }

  private func postNotification(_ center: UNUserNotificationCenter) {
    // Local notifications need no entitlement, but they do need a one-time
    // user grant. On denial we exit quietly (agetor falls back to a plain
    // Utils.showNotification on its side).
    center.requestAuthorization(options: [.alert, .sound]) { [opts] granted, _ in
      // Exit non-zero on denial so agetor's spawn-side fallback fires a plain
      // Utils.showNotification (best-effort) rather than the user getting no
      // notification at all. requestAuthorization also returns granted=false
      // for a previously-denied state, so this degrades consistently.
      guard granted else { exit(2) }

      let content = UNMutableNotificationContent()
      content.title = opts.title ?? ""
      if let subtitle = opts.subtitle { content.subtitle = subtitle }
      content.body = opts.message
      if !opts.silent { content.sound = .default }
      if let url = opts.url { content.userInfo = ["url": url] }

      let request = UNNotificationRequest(
        identifier: UUID().uuidString, content: content, trigger: nil)
      center.add(request) { _ in
        // Delivered to the system; the helper no longer needs to run.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { exit(0) }
      }
    }
    // Safety net if neither the auth callback nor `add` ever completes. Uses a
    // generous window so a first-run user has time to answer the permission
    // dialog (grant -> `add` -> exit 0 well before this fires), and exits
    // NON-zero: if we get here we never posted, so agetor should treat it as a
    // failed post. 120s so an AFK first-run doesn't drop the notification
    // prematurely.
    scheduleExit(after: 120, code: 2)
  }

  // Click handling: fires in this process, whether it stayed alive or was
  // relaunched by the system for the click.
  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler unCompletionHandler: @escaping () -> Void
  ) {
    guard response.actionIdentifier == UNNotificationDefaultActionIdentifier,
      let urlString = response.notification.request.content.userInfo["url"] as? String,
      let url = URL(string: urlString),
      url.scheme == "agetor"  // defense in depth: only ever open our own deep links
    else {
      unCompletionHandler()
      exit(0)
    }

    // Ack UN only *after* the open has been handed to LaunchServices, never
    // before. Acking declares we're done handling the response, at which
    // point nothing obliges the system to keep this relaunched agent alive —
    // and a deep link that never left the process is exactly the silent
    // "click does nothing" failure this helper exists to prevent. A late ack
    // costs at most a UN warning; an early one can cost the click.
    activateMainAppAndOpen(url, ack: unCompletionHandler)
  }

  // Opens the agetor:// deep link and brings the main app forward. Split out
  // of didReceive because there are two distinct completion callbacks in play
  // here — UN's (`ack`) and NSWorkspace's (below) — and keeping them in one
  // function invites confusing them.
  private func activateMainAppAndOpen(_ url: URL, ack: @escaping () -> Void) {
    let target = NSRunningApplication.runningApplications(
      withBundleIdentifier: "sh.alamops.agetor"
    ).first

    // macOS 14 (Sonoma) made activation cooperative: NSApplication.activate
    // and NSRunningApplication.activate(options: .activateIgnoringOtherApps)
    // are deprecated no-ops now — a denied activation request just bounces
    // the Dock icon instead of raising the window. A request is honored only
    // once the currently-active app YIELDS its activation right to the
    // target (or NSWorkspace performs that yield on our behalf below).
    // Clicking a notification makes this helper — even though it's
    // .accessory — the active app, holding a real, yieldable activation
    // right. Explicitly yielding it to the main app before opening is what
    // makes the subsequent activation request actually get honored instead
    // of just bouncing. yieldActivation(to:) itself only exists on macOS
    // 14.0+, and the helper is built targeting macOS 13, so it must stay
    // guarded.
    if let target, #available(macOS 14.0, *) {
      NSApp.yieldActivation(to: target)
    }

    // Safety net: if NSWorkspace's completion handler below never fires (the
    // open hangs, LaunchServices is slow, whatever), don't leave the
    // relaunched helper running forever.
    scheduleExit(after: 5)

    let cfg = NSWorkspace.OpenConfiguration()
    cfg.activates = true
    NSWorkspace.shared.open(url, configuration: cfg) { openedApp, openError in
      // NSWorkspace's own completion, on a background queue — not UN's `ack`.
      if openedApp == nil || openError != nil {
        // The cooperative yield only helps if NSWorkspace's own activation
        // follow-through succeeds; if the open itself failed, fall back to a
        // direct activate request. No .activateIgnoringOtherApps — that flag
        // is ignored on 14+ and the selector is deprecated.
        target?.activate(options: [.activateAllWindows])
        if let openError {
          let msg = "AgetorNotifier: open agetor:// failed: \(openError)\n"
          FileHandle.standardError.write(Data(msg.utf8))
        }
      }
      exit(0)
    }

    // `open` returns once the request is queued with LaunchServices, so by
    // here the deep link survives this process dying. Safe to ack UN.
    ack()
  }

  // If agetor is frontmost when the notification arrives, still show the banner
  // (default macOS behavior suppresses foreground alerts).
  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    // Respect --silent even on the foreground-present path (the helper is
    // briefly frontmost right after posting).
    completionHandler(opts.silent ? [.banner] : [.banner, .sound])
  }

  private func scheduleExit(after seconds: Double, code: Int32 = 0) {
    DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { exit(code) }
  }
}

let app = NSApplication.shared
// Agent app: no Dock icon / menu bar (complements LSUIElement in Info.plist).
app.setActivationPolicy(.accessory)
let delegate = AppDelegate(parseArgs(CommandLine.arguments))
app.delegate = delegate
app.run()
