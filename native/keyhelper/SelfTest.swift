import CryptoKit
import Foundation

/// `keyhelper selftest-vectors <dir>`: checks the SAS, pairing mailbox, canonical JSON and QR vectors the TypeScript package
/// owns. Prints each file it checked, skips a file that is absent, and exits non-zero on any mismatch.
func runVectorSelfTest(dir: String) -> Int32 {
    var failures = 0
    func fail(_ file: String, _ what: String) {
        failures += 1
        FileHandle.standardError.write(Data("FAIL \(file): \(what)\n".utf8))
    }
    func load(_ name: String) -> [String: Any]? {
        let url = URL(fileURLWithPath: dir).appendingPathComponent(name)
        guard let data = try? Data(contentsOf: url) else {
            print("skipped \(name) (absent)")
            return nil
        }
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            fail(name, "not a JSON object")
            return nil
        }
        return obj
    }

    if let v = load("agetor-derive.json") {
        let name = "agetor-derive.json"
        if let hh = Hex.decode(v["handshakeHash"] as? String ?? "", bytes: 32), Derive.sas(handshakeHash: hh) != (v["sas"] as? String) { fail(name, "sas") }
        for c in (v["sasCases"] as? [[String: Any]]) ?? [] {
            guard let h = Hex.decode(c["handshakeHash"] as? String ?? ""), let code = c["code"] as? String else { fail(name, "bad sas case"); continue }
            if Derive.sas(handshakeHash: h) != code { fail(name, "sas case \(code)") }
        }
        if let secret = Hex.decode(v["pairingSecret"] as? String ?? "", bytes: 32), let pm = v["pairingMailbox"] as? [String: Any] {
            let key = Derive.pairingMailboxKey(secret)
            if Hex.encode(key) != (pm["key"] as? String) { fail(name, "pairing mailbox key") }
            if Hex.encode(Derive.mailboxId(key)) != (pm["id"] as? String) { fail(name, "pairing mailbox id") }
        } else { fail(name, "pairing secret") }
        print("checked \(name)")
    }

    if let v = load("agetor-canonical-json.json") {
        let name = "agetor-canonical-json.json"
        for c in (v["cases"] as? [[String: Any]]) ?? [] {
            let caseName = c["name"] as? String ?? "?"
            guard let input = c["input"], let expected = c["canonical"] as? String else { fail(name, "bad case \(caseName)"); continue }
            do {
                let got = try Canonical.serialize(input)
                if got != expected { fail(name, "\(caseName): got \(got)") }
            } catch { fail(name, "\(caseName): \(error)") }
        }
        print("checked \(name)")
    }

    if let v = load("agetor-qr.json") {
        let name = "agetor-qr.json"
        for c in (v["cases"] as? [[String: Any]]) ?? [] {
            guard let payload = c["payload"], let qr = c["qr"] as? String else { fail(name, "bad case"); continue }
            do {
                let got = Base64URL.encode(Data(try Canonical.serialize(payload).utf8))
                if got != qr { fail(name, "qr mismatch") }
            } catch { fail(name, "\(error)") }
        }
        print("checked \(name)")
    }

    if failures > 0 {
        FileHandle.standardError.write(Data("\(failures) vector failure(s)\n".utf8))
        return 1
    }
    print("vectors ok")
    return 0
}

/// `keyhelper selftest`: needs the profile-backed signature. Verifies the key stores work and prints what was created.
func runKeychainSelfTest() -> Int32 {
    let keys = Keys()
    do {
        let core = try keys.corePublicKey()
        print("data-protection keychain: core key present (\(Hex.encode(core).prefix(8))…)")
        let registry = try keys.registryPublicKey()
        print("Secure Enclave available: registry key present (\(Hex.encode(registry).prefix(8))…)")
        let a = try keys.diffieHellman(peerPub: Curve25519.KeyAgreement.PrivateKey().publicKey.rawRepresentation)
        print("dh ok (\(a.count) bytes)")
        print("selftest ok")
        return 0
    } catch let e as HelperError {
        FileHandle.standardError.write(Data("selftest failed: \(e.code): \(e.message)\n".utf8))
        return 2
    } catch {
        FileHandle.standardError.write(Data("selftest failed: \(error)\n".utf8))
        return 2
    }
}
