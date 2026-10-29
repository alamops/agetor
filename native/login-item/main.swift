// agetor-login-item — the launchd job's program and the SMAppService client for
// Agetor's "keep running in the background" feature.
//
// It lives in Contents/MacOS of the app bundle and does two jobs:
//
//   1. Registration. `register` / `unregister` / `reregister` / `status` /
//      `open-settings` / `info` drive SMAppService.agent(plistName:) for the
//      LaunchAgent plist shipped in Contents/Library/LaunchAgents. The Bun core
//      runs this binary (through coreSpawn) and reads the one JSON line it
//      prints; it cannot call SMAppService itself.
//   2. The job itself. The plist's BundleProgram points here with
//      `ProgramArguments = [agetor-login-item, run]`. `run` works out which
//      bundle it lives in, sets the environment the supervisor needs, and
//      execv()s the bundle's own `bun` on app/daemon/login-daemon.js. It has to
//      be a helper because plist ProgramArguments are not bundle-relative and a
//      plist cannot expand $HOME (docs/plans/always-on-host.md §3.1).
//
// CLI contract (docs/plans/always-on-host.md §3.3 "Swift helper contract"):
//   agetor-login-item info | status | register | unregister | reregister
//                     | open-settings | run
// Every handled command prints exactly one JSON line on stdout and exits 0 —
// including a `register` that failed (`{"ok":false,...}`), because the caller
// treats that as data, not as a crash. Exit codes: 64 usage, 70 internal error
// (and `run`'s failed execv, so launchd's KeepAlive retries).
//
// JSON shapes (they must match HelperInfo / HelperResult in
// src/bun/login-item-helper.ts field for field):
//   info:     {bundlePath, bundleId, channel, label, plist, signed, teamId, location}
//             label and plist are null on a dev build (no version.json channel).
//   status:   {registration}
//   register / unregister / reregister:
//             {ok, registration, error?: {domain, code, message}}
//   open-settings: {ok: true}
//   registration is one of enabled | requiresApproval | notRegistered | notFound.
//
// Channel: Contents/Resources/version.json `channel`. "stable" and "canary" map
// to their LaunchAgent labels; anything else (or a missing file — e.g. this
// binary run straight out of vendor/) is channel "dev" with no label, and every
// command that needs a label answers notFound instead of touching launchd.
//
// arm64-only, no third-party dependency. Build: scripts/build-login-item.ts.

import Foundation
import Security
import ServiceManagement

// MARK: - Output

func emit(_ object: [String: Any]) -> Never {
  let data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data("{}".utf8)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
  exit(0)
}

func die(_ message: String, code: Int32) -> Never {
  FileHandle.standardError.write(Data("agetor-login-item: \(message)\n".utf8))
  exit(code)
}

// MARK: - Bundle resolution

/// Absolute, symlink-resolved path of this executable. `argv[0]` is useless
/// under launchd's BundleProgram (it is the bare name from ProgramArguments),
/// so ask dyld.
func executablePath() -> String {
  var size: UInt32 = 0
  _NSGetExecutablePath(nil, &size)
  var buffer = [CChar](repeating: 0, count: Int(size))
  guard _NSGetExecutablePath(&buffer, &size) == 0 else { die("cannot resolve own path", code: 70) }
  let raw = String(cString: buffer)
  return URL(fileURLWithPath: raw).resolvingSymlinksInPath().path
}

/// `<App>.app/Contents/MacOS/agetor-login-item` → `<App>.app` (two directories
/// above the executable's own). A binary run from anywhere else (the unbundled
/// vendor/ copy) has no bundle: its own directory stands in so `info` still
/// answers with `location: "other"`.
func resolveBundle(executable: String) -> (path: String, isBundle: Bool) {
  let macOSDir = URL(fileURLWithPath: executable).deletingLastPathComponent()
  let contentsDir = macOSDir.deletingLastPathComponent()
  if macOSDir.lastPathComponent == "MacOS", contentsDir.lastPathComponent == "Contents" {
    return (contentsDir.deletingLastPathComponent().path, true)
  }
  return (macOSDir.path, false)
}

struct Channel {
  let name: String       // stable | canary | dev
  let label: String?     // nil for dev
  var plist: String? { label.map { "\($0).plist" } }
}

func readChannel(bundle: String, isBundle: Bool) -> Channel {
  let dev = Channel(name: "dev", label: nil)
  guard isBundle else { return dev }
  let url = URL(fileURLWithPath: bundle).appendingPathComponent("Contents/Resources/version.json")
  guard
    let data = try? Data(contentsOf: url),
    let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
    let channel = json["channel"] as? String
  else { return dev }
  switch channel {
  case "stable": return Channel(name: "stable", label: "sh.alamops.agetor.daemon")
  case "canary": return Channel(name: "canary", label: "sh.alamops.agetor.canary.daemon")
  default: return dev
  }
}

func readBundleId(bundle: String, isBundle: Bool) -> String {
  let fallback = "sh.alamops.agetor"
  guard isBundle else { return fallback }
  let url = URL(fileURLWithPath: bundle).appendingPathComponent("Contents/Info.plist")
  guard
    let data = try? Data(contentsOf: url),
    let plist = (try? PropertyListSerialization.propertyList(from: data, format: nil)) as? [String: Any],
    let id = plist["CFBundleIdentifier"] as? String
  else { return fallback }
  return id
}

func bundleLocation(_ path: String) -> String {
  if path.contains("/AppTranslocation/") { return "translocated" }
  if path.hasPrefix("/Volumes/") { return "volume" }
  if path.hasPrefix("/Applications/") { return "applications" }
  let home = NSHomeDirectory()
  if !home.isEmpty, home != "/", path.hasPrefix(home + "/Applications/") { return "user-applications" }
  return "other"
}

// MARK: - Code signature

/// Team id of this binary's signature, or nil when unsigned / ad-hoc. A linker-
/// signed ad-hoc binary (what `swiftc` leaves behind) carries no team id and the
/// ad-hoc flag, so both read as unsigned — which is the point: SMAppService
/// refuses to run an ad-hoc bundle's login item in any case worth supporting.
func signingTeamId() -> String? {
  var code: SecCode?
  guard SecCodeCopySelf(SecCSFlags(), &code) == errSecSuccess, let selfCode = code else { return nil }
  var staticCode: SecStaticCode?
  guard SecCodeCopyStaticCode(selfCode, SecCSFlags(), &staticCode) == errSecSuccess, let sc = staticCode else { return nil }
  var infoRef: CFDictionary?
  guard
    SecCodeCopySigningInformation(sc, SecCSFlags(rawValue: kSecCSSigningInformation), &infoRef) == errSecSuccess,
    let info = infoRef as? [String: Any]
  else { return nil }
  if let flags = info[kSecCodeInfoFlags as String] as? UInt32, flags & SecCodeSignatureFlags.adhoc.rawValue != 0 {
    return nil
  }
  return info[kSecCodeInfoTeamIdentifier as String] as? String
}

// MARK: - SMAppService

func registrationName(_ status: SMAppService.Status) -> String {
  switch status {
  case .enabled: return "enabled"
  case .requiresApproval: return "requiresApproval"
  case .notRegistered: return "notRegistered"
  case .notFound: return "notFound"
  @unknown default: return "notFound"
  }
}

func errorObject(_ error: Error) -> [String: Any] {
  let ns = error as NSError
  return ["domain": ns.domain, "code": ns.code, "message": ns.localizedDescription]
}

func noLabelResult(_ what: String) -> [String: Any] {
  [
    "ok": false,
    "registration": "notFound",
    "error": ["domain": "agetor-login-item", "code": 0, "message": "\(what): this build has no login item (dev channel)"],
  ]
}

/// SMAppService.unregister(completionHandler:) is callback-based; this build is a
/// plain command-line tool with no run loop, so wait on a semaphore. 20 s is far
/// above anything launchd needs and still bounded.
func unregisterAndWait(_ service: SMAppService) -> Error? {
  let done = DispatchSemaphore(value: 0)
  var failure: Error?
  service.unregister { error in
    failure = error
    done.signal()
  }
  if done.wait(timeout: .now() + 20) == .timedOut {
    return NSError(domain: "agetor-login-item", code: 1, userInfo: [NSLocalizedDescriptionKey: "unregister timed out"])
  }
  return failure
}

func result(_ service: SMAppService, error: Error?) -> [String: Any] {
  var out: [String: Any] = ["ok": error == nil, "registration": registrationName(service.status)]
  if let error { out["error"] = errorObject(error) }
  return out
}

// MARK: - Commands

let args = CommandLine.arguments
guard args.count == 2 else { die("usage: agetor-login-item info|status|register|unregister|reregister|open-settings|run", code: 64) }
let command = args[1]

let exe = executablePath()
let (bundlePath, isBundle) = resolveBundle(executable: exe)
let channel = readChannel(bundle: bundlePath, isBundle: isBundle)

func service() -> SMAppService? {
  guard let plist = channel.plist else { return nil }
  return SMAppService.agent(plistName: plist)
}

switch command {
case "info":
  let team = signingTeamId()
  emit([
    "bundlePath": bundlePath,
    "bundleId": readBundleId(bundle: bundlePath, isBundle: isBundle),
    "channel": channel.name,
    "label": channel.label as Any? ?? NSNull(),
    "plist": channel.plist as Any? ?? NSNull(),
    "signed": team != nil,
    "teamId": team as Any? ?? NSNull(),
    "location": bundleLocation(bundlePath),
  ])

case "status":
  guard let svc = service() else { emit(["registration": "notFound"]) }
  emit(["registration": registrationName(svc.status)])

case "register":
  guard let svc = service() else { emit(noLabelResult("register")) }
  var failure: Error?
  do { try svc.register() } catch { failure = error }
  emit(result(svc, error: failure))

case "unregister":
  guard let svc = service() else { emit(noLabelResult("unregister")) }
  // The core calls this from inside the job's own process tree when the user turns
  // the feature off from the daemon; unregistering makes launchd SIGTERM the job's
  // process group, which would take this helper down before it could answer. A new
  // session leaves the group first. Fails harmlessly when already a group leader.
  _ = setsid()
  emit(result(svc, error: unregisterAndWait(svc)))

case "reregister":
  guard let svc = service() else { emit(noLabelResult("reregister")) }
  _ = setsid()
  // An unregister error (typically "not registered") must not block the register
  // that follows; the register outcome is the answer. The 500 ms gap avoids
  // SMAppServiceErrorDomain code 1 when register() follows unregister() too fast
  // (Apple DTS 768592).
  _ = unregisterAndWait(svc)
  Thread.sleep(forTimeInterval: 0.5)
  var failure: Error?
  do { try svc.register() } catch { failure = error }
  emit(result(svc, error: failure))

case "open-settings":
  SMAppService.openSystemSettingsLoginItems()
  emit(["ok": true])

case "run":
  guard let label = channel.label else { emit(noLabelResult("run")) }
  setenv("AGETOR_LAUNCHED_BY", "login-item", 1)
  setenv("AGETOR_LOGIN_ITEM_BUNDLE", bundlePath, 1)
  setenv("AGETOR_LOGIN_ITEM_LABEL", label, 1)
  if channel.name != "stable" {
    // A canary app's job must never touch the real ~/.agetor or its port.
    let home = NSHomeDirectory()
    // An empty value counts as unset (a stray `VAR=` must not pin the real dir).
    for (key, value) in [("AGETOR_DATA_DIR", "\(home)/.agetor-dev"), ("AGETOR_API_PORT", "4318")] {
      if let current = getenv(key), current.pointee != 0 { continue }
      setenv(key, value, 1)
    }
  }
  let bun = "\(bundlePath)/Contents/MacOS/bun"
  let script = "\(bundlePath)/Contents/Resources/app/daemon/login-daemon.js"
  var argv: [UnsafeMutablePointer<CChar>?] = [strdup("bun"), strdup(script), nil]
  execv(bun, &argv)
  // Only reached when execv failed. Non-zero so launchd's KeepAlive retries.
  die("execv \(bun) failed: \(String(cString: strerror(errno)))", code: 70)

default:
  die("unknown command '\(command)' (expected info|status|register|unregister|reregister|open-settings|run)", code: 64)
}
