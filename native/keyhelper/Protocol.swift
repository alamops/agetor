import Foundation

/// Error with the machine-readable code the core maps (docs/plans/remote-readiness.md section 3.3).
struct HelperError: Error {
    let code: String
    let message: String
    init(_ code: String, _ message: String) {
        self.code = code
        self.message = message
    }
}

/// JSON lines on stdout. Writes are serialized because pairing answers arrive from the UI thread.
enum Output {
    private static let lock = NSLock()

    static func write(_ obj: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]) else { return }
        lock.lock()
        defer { lock.unlock() }
        FileHandle.standardOutput.write(data + Data([0x0A]))
    }

    static func ok(_ id: Any, _ result: [String: Any]) { write(["id": id, "ok": true, "result": result]) }

    static func fail(_ id: Any, _ error: HelperError) {
        write(["id": id, "ok": false, "error": ["code": error.code, "message": error.message]])
    }

    static func event(_ name: String) { write(["event": name]) }
}

/// Longest string argument the helper accepts, in UTF-8 bytes. The core never sends more.
let maxStringBytes = 2048
let maxLineBytes = 16 * 1024

enum Args {
    static func string(_ a: [String: Any], _ key: String, max: Int = maxStringBytes) throws -> String {
        guard let s = a[key] as? String, s.utf8.count <= max else { throw HelperError("bad-args", "\(key) missing or too long") }
        return s
    }

    static func hex(_ a: [String: Any], _ key: String, bytes: Int) throws -> Data {
        let s = try string(a, key, max: bytes * 2 + 2)
        guard let d = Hex.decode(s, bytes: bytes) else { throw HelperError("bad-args", "\(key) must be \(bytes) bytes of lowercase hex") }
        return d
    }

    static func int(_ a: [String: Any], _ key: String) throws -> Int64 {
        guard let n = a[key] as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue == Double(n.int64Value), n.int64Value >= 0 else {
            throw HelperError("bad-args", "\(key) must be a non-negative integer")
        }
        return n.int64Value
    }
}

/// Handles one request line. Long-running commands (pairing) answer later from the UI thread.
final class Dispatcher {
    private let keys = Keys()
    private let revocation = Revocation()

    func handle(line: String) {
        if line.utf8.count > maxLineBytes {
            Output.fail(NSNull(), HelperError("line-too-long", "request line over \(maxLineBytes) bytes"))
            return
        }
        guard let data = line.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            Output.fail(NSNull(), HelperError("bad-json", "request is not a JSON object"))
            return
        }
        let id: Any = obj["id"] ?? NSNull()
        guard let cmd = obj["cmd"] as? String, cmd.utf8.count <= 32 else {
            Output.fail(id, HelperError("bad-args", "cmd missing"))
            return
        }
        let args = (obj["args"] as? [String: Any]) ?? [:]
        do {
            switch cmd {
            case "status":
                Output.ok(id, try status())
            case "dh":
                let peer = try Args.hex(args, "peerPub", bytes: 32)
                Output.ok(id, ["shared": Hex.encode(try keys.diffieHellman(peerPub: peer))])
            case "revoked":
                Output.ok(id, ["ids": try revocation.revoked()])
            case "revoke":
                let rid = try Args.hex(args, "id", bytes: 16)
                Output.ok(id, ["ids": try revocation.revoke(id: Hex.encode(rid))])
            case "revoke-all":
                let ids = try revocation.revokeAllSigned()
                let pub = try keys.replaceCoreKey()
                Output.ok(id, ["ids": ids, "corePub": Hex.encode(pub)])
            case "pair-begin":
                let relayUrl = try Args.string(args, "relayUrl")
                let macName = try Args.string(args, "macName", max: 160)
                let expiresAt = try Args.int(args, "expiresAt")
                let corePub = try keys.corePublicKey()
                _ = try keys.registryPublicKey()  // refuse early when there is no Secure Enclave (grill D3)
                DispatchQueue.main.async {
                    do {
                        let r = try PairingController.shared.begin(relayUrl: relayUrl, macName: macName, expiresAt: expiresAt, corePub: corePub)
                        Output.ok(id, ["pairingSecret": Hex.encode(r.secret), "qr": r.qr])
                    } catch let e as HelperError {
                        Output.fail(id, e)
                    } catch {
                        Output.fail(id, HelperError("internal", "pairing could not start"))
                    }
                }
            case "pair-complete":
                let request = try PairRequest(args: args)
                DispatchQueue.main.async {
                    PairingController.shared.complete(request: request, keys: self.keys, revocation: self.revocation) { result in
                        switch result {
                        case .success(let r):
                            Output.ok(id, ["level": r.level, "entry": r.entry, "sig": Hex.encode(r.signature)])
                        case .failure(let e):
                            Output.fail(id, e)
                        }
                    }
                }
            case "pair-cancel":
                DispatchQueue.main.async {
                    PairingController.shared.cancel(reason: "cancelled")
                    Output.ok(id, [:])
                }
            default:
                Output.fail(id, HelperError("unknown-command", "unknown command"))
            }
        } catch let e as HelperError {
            Output.fail(id, e)
        } catch {
            Output.fail(id, HelperError("internal", "command failed"))
        }
    }

    private func status() throws -> [String: Any] {
        let core = try keys.corePublicKey()
        let registry = try keys.registryPublicKey()
        return ["version": helperVersion, "secureEnclave": true, "corePub": Hex.encode(core), "registryPub": Hex.encode(registry)]
    }
}

let helperVersion = "1.0.0"

/// Read stdin lines until EOF, then exit: the core died, and so does the helper (and its window).
func runStdinLoop(_ dispatcher: Dispatcher) {
    let queue = DispatchQueue(label: "keyhelper.commands", attributes: .concurrent)
    let inFlight = DispatchGroup()
    while let line = readLine(strippingNewline: true) {
        if line.isEmpty { continue }
        inFlight.enter()
        queue.async {
            dispatcher.handle(line: line)
            inFlight.leave()
        }
    }
    // Let the answers to commands already read go out (a pipe closed right after a request), then leave.
    _ = inFlight.wait(timeout: .now() + 2)
    exit(0)
}
