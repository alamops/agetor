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
// CLI contract (invoked by src/bun/notifier.ts; see docs/plans/duplicated-macos-notifications.md):
//   notifier --title <t> --message <m> [--subtitle <s>] [--url <agetor://task/...>] [--silent]
//            [--id <identifier>] [--kind <kind>] [--urgency needs-you|quiet] [--sound-over <urgency>]...
//   notifier --remove --id <identifier> [--url <agetor://task/...>] [--if-kind <kind>]...
//   notifier --list
//   notifier                      # no args: click relaunch, waits for didReceive
// Mode order: --list, --remove, post (a --title was given), else click relaunch.
// Exit codes: 0 ok · 1 remove/list safety timeout, or a post the system refused
// to add · 2 post permission denied or timed out · 64 usage (--remove without
// --id).
// Stdout acks (src/bun/notifier.ts): a post prints `posted <identifier>`,
// --remove prints `removed <n>`, --list starts with `agetor-notifier list`. A
// helper that predates these modes prints none of them, which is how agetor
// tells a stale build from a successful call.
//
// One entry per task: a post carrying --id uses it as the request identifier,
// so a repeat post REPLACES the previous banner instead of stacking a new one.
// Sound rule: the replacement plays a sound only when --silent is absent AND
// either nothing for this task is in Notification Center yet, or the entry
// being replaced carries an urgency listed in --sound-over ("unknown" stands
// for an entry with no stored urgency, e.g. one posted by an older build). The
// decision is read from the delivered list, so it survives a helper restart.
// Entries posted by older builds (random identifiers, matched by --url) are
// removed when the same task posts again. --remove and --list never request
// authorization, so they can never pop the permission prompt.
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
  var id: String?
  var kind: String?
  var urgency: String?
  var soundOver: [String] = []
  var ifKinds: [String] = []
  var remove: Bool = false
  var list: Bool = false

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
    case "--id": o.id = value; i += 2
    case "--kind": o.kind = value; i += 2
    case "--urgency": o.urgency = value; i += 2
    case "--sound-over": if let value { o.soundOver.append(value) }; i += 2
    case "--if-kind": if let value { o.ifKinds.append(value) }; i += 2
    case "--remove": o.remove = true; i += 1
    case "--list": o.list = true; i += 1
    default: i += 1
    }
  }
  return o
}

/// The post path decides `playSound` on a Notification Center callback queue,
/// while `willPresent` may be delivered on another thread; this tiny lock keeps
/// the hand-off race-free without making the whole delegate Sendable.
final class SoundGate: @unchecked Sendable {
  private let lock = NSLock()
  private var value: Bool

  init(_ initial: Bool) { value = initial }

  func set(_ newValue: Bool) {
    lock.lock()
    value = newValue
    lock.unlock()
  }

  func get() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return value
  }
}

final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
  private let opts: Options
  private let soundGate: SoundGate

  init(_ opts: Options) {
    self.opts = opts
    // Until a post decides otherwise, foreground presentation honors --silent
    // exactly as before.
    self.soundGate = SoundGate(!opts.silent)
  }

  func applicationDidFinishLaunching(_ note: Notification) {
    let center = UNUserNotificationCenter.current()
    // Assign the delegate BEFORE launch completes so a click-relaunch delivers
    // its response to didReceive (Apple's documented requirement).
    center.delegate = self

    if opts.list {
      listAgetorURLs(center)
    } else if opts.remove {
      removeNotifications(center)
    } else if opts.hasContent {
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
    center.requestAuthorization(options: [.alert, .sound]) { [opts, soundGate] granted, _ in
      // Exit non-zero on denial so agetor's spawn-side fallback fires a plain
      // Utils.showNotification (best-effort) rather than the user getting no
      // notification at all. requestAuthorization also returns granted=false
      // for a previously-denied state, so this degrades consistently.
      guard granted else { exit(2) }

      // Without --id there is nothing to replace: today's behavior, a random
      // identifier and no query of Notification Center.
      guard let id = opts.id else {
        soundGate.set(!opts.silent)
        Self.add(center, opts: opts, identifier: UUID().uuidString, playSound: !opts.silent)
        return
      }

      center.getDeliveredNotifications { delivered in
        var existingUrgency: String?
        var oldStyleIds: [String] = []
        for n in delivered {
          let ident = n.request.identifier
          let info = n.request.content.userInfo
          if ident == id {
            existingUrgency = (info["urgency"] as? String) ?? "unknown"
          } else if let url = opts.url, info["url"] as? String == url {
            // Posted by an older build under a random identifier.
            oldStyleIds.append(ident)
            if existingUrgency == nil { existingUrgency = "unknown" }
          }
        }

        // A repeat post is quiet unless the entry it replaces was a lower
        // urgency the caller listed in --sound-over (an escalation).
        let playSound =
          !opts.silent && (existingUrgency.map { opts.soundOver.contains($0) } ?? true)

        if !oldStyleIds.isEmpty {
          center.removeDeliveredNotifications(withIdentifiers: oldStyleIds)
        }
        // Publish before `add` so a willPresent triggered by it sees the final
        // decision.
        soundGate.set(playSound)
        Self.add(center, opts: opts, identifier: id, playSound: playSound)
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

  private static func add(
    _ center: UNUserNotificationCenter, opts: Options, identifier: String, playSound: Bool
  ) {
    let content = UNMutableNotificationContent()
    content.title = opts.title ?? ""
    if let subtitle = opts.subtitle { content.subtitle = subtitle }
    content.body = opts.message
    content.sound = playSound ? .default : nil
    var info: [String: String] = [:]
    if let url = opts.url { info["url"] = url }
    if let kind = opts.kind { info["kind"] = kind }
    if let urgency = opts.urgency { info["urgency"] = urgency }
    if !info.isEmpty { content.userInfo = info }

    let request = UNNotificationRequest(identifier: identifier, content: content, trigger: nil)
    center.add(request) { error in
      if let error {
        // Nothing reached Notification Center: no `posted` ack, and exit 1 (not
        // 2, which means permission denied) so agetor falls back to a plain
        // notification instead of assuming this one was shown.
        let msg = "AgetorNotifier: failed to post notification: \(error)\n"
        FileHandle.standardError.write(Data(msg.utf8))
        exit(1)
      }
      FileHandle.standardOutput.write(Data("posted \(identifier)\n".utf8))
      // Delivered to the system; the helper no longer needs to run.
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { exit(0) }
    }
  }

  // Removal: no authorization request (a removal must never pop the permission
  // prompt). Targets are the entry with the task's identifier plus any
  // old-style entry carrying the task's url; --if-kind narrows them to the
  // listed kinds, and old-style entries have no kind so they never match then.
  private func removeNotifications(_ center: UNUserNotificationCenter) {
    guard let id = opts.id else {
      FileHandle.standardError.write(
        Data("usage: notifier --remove --id <identifier> [--url <url>] [--if-kind <kind>]...\n".utf8))
      exit(64)
    }
    center.getDeliveredNotifications { [opts] delivered in
      var targets: [String] = []
      for n in delivered {
        let ident = n.request.identifier
        let info = n.request.content.userInfo
        let matches = ident == id || (opts.url != nil && info["url"] as? String == opts.url)
        guard matches else { continue }
        if !opts.ifKinds.isEmpty {
          guard let kind = info["kind"] as? String, opts.ifKinds.contains(kind) else { continue }
        }
        targets.append(ident)
      }
      if !targets.isEmpty {
        center.removeDeliveredNotifications(withIdentifiers: targets)
      }
      FileHandle.standardOutput.write(Data("removed \(targets.count)\n".utf8))
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { exit(0) }
    }
    scheduleExit(after: 10, code: 1)
  }

  // List: a header line, then the agetor:// url of every delivered entry,
  // distinct and sorted, so agetor can reconcile its own bookkeeping with
  // Notification Center.
  private func listAgetorURLs(_ center: UNUserNotificationCenter) {
    center.getDeliveredNotifications { delivered in
      var urls = Set<String>()
      for n in delivered {
        if let url = n.request.content.userInfo["url"] as? String, url.hasPrefix("agetor://") {
          urls.insert(url)
        }
      }
      let out = (["agetor-notifier list"] + urls.sorted()).map { $0 + "\n" }.joined()
      FileHandle.standardOutput.write(Data(out.utf8))
      exit(0)
    }
    scheduleExit(after: 10, code: 1)
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
    // Respect --silent, and the post's sound decision (a quiet replacement of
    // an existing entry), even on the foreground-present path (the helper is
    // briefly frontmost right after posting).
    completionHandler(soundGate.get() ? [.banner, .sound] : [.banner])
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
