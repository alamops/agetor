import AppKit
import Foundation

// Agetor key helper. Modes:
//   (no arguments)                 JSON-lines command loop on stdin/stdout, spawned by the core (docs/plans/remote-readiness.md section 3.3)
//   selftest                       exercise the keychain items and the Secure Enclave key (needs the signed, profile-backed build)
//   selftest-vectors <dir>         check SAS, canonical JSON, QR and pairing-mailbox vectors (works ad hoc)

let arguments = CommandLine.arguments
if arguments.count >= 2 {
    switch arguments[1] {
    case "selftest":
        exit(runKeychainSelfTest())
    case "selftest-vectors":
        guard arguments.count >= 3 else {
            FileHandle.standardError.write(Data("usage: keyhelper selftest-vectors <vectors dir>\n".utf8))
            exit(64)
        }
        exit(runVectorSelfTest(dir: arguments[2]))
    default:
        FileHandle.standardError.write(Data("unknown mode\n".utf8))
        exit(64)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let dispatcher = Dispatcher()
Thread.detachNewThread { runStdinLoop(dispatcher) }
app.run()
