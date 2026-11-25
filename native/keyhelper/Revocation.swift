import Foundation

/// The helper's own lists, in its data-protection keychain item. Both are append-only: there is no code path that
/// removes an id, so replaying an old signed registry row can never bring a revoked device back (spec "Device registry").
final class Revocation {
    private let lock = NSLock()
    private let revokedAccount = "revoked"
    private let signedAccount = "signed"

    private func load(_ account: String) throws -> [String] {
        guard let data = try Keychain.read(service: Keychain.listService, account: account) else { return [] }
        guard let arr = try? JSONSerialization.jsonObject(with: data) as? [String] else {
            throw HelperError("keychain-unavailable", "the \(account) list is unreadable")
        }
        return arr
    }

    private func store(_ account: String, _ ids: [String]) throws {
        let data = try JSONSerialization.data(withJSONObject: ids, options: [.sortedKeys])
        try Keychain.write(service: Keychain.listService, account: account, data: data)
    }

    func revoked() throws -> [String] {
        lock.lock()
        defer { lock.unlock() }
        return try load(revokedAccount)
    }

    func revoke(id: String) throws -> [String] {
        lock.lock()
        defer { lock.unlock() }
        var ids = try load(revokedAccount)
        if !ids.contains(id) {
            ids.append(id)
            try store(revokedAccount, ids)
        }
        return ids
    }

    /// Record an id the helper is about to sign, BEFORE the signature leaves the helper, so Revoke all can always cover it.
    func recordSigned(id: String) throws {
        lock.lock()
        defer { lock.unlock() }
        var ids = try load(signedAccount)
        if !ids.contains(id) {
            ids.append(id)
            try store(signedAccount, ids)
        }
    }

    /// Revoke every id the helper has ever signed.
    func revokeAllSigned() throws -> [String] {
        lock.lock()
        defer { lock.unlock() }
        var revoked = try load(revokedAccount)
        for id in try load(signedAccount) where !revoked.contains(id) { revoked.append(id) }
        try store(revokedAccount, revoked)
        return revoked
    }
}
