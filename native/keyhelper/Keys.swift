import CryptoKit
import Foundation
import LocalAuthentication
import Security

/// Data-protection keychain access under the helper's own access group (set by the entitlements). There is NO login-keychain
/// fallback (grill D3): when the entitlement or the Secure Enclave is missing, the helper answers `keychain-unavailable` or
/// `no-secure-enclave` and pairing is refused.
enum Keychain {
    static let coreService = "sh.alamops.agetor.keyhelper.core-key"
    static let registryService = "sh.alamops.agetor.keyhelper.registry-key"
    static let listService = "sh.alamops.agetor.keyhelper.lists"

    private static func query(_ service: String, _ account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecUseDataProtectionKeychain as String: true,
        ]
    }

    private static func map(_ status: OSStatus) -> HelperError {
        HelperError("keychain-unavailable", "keychain error \(status)")
    }

    static func read(service: String, account: String) throws -> Data? {
        var q = query(service, account)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else { throw map(status) }
        return data
    }

    static func write(service: String, account: String, data: Data) throws {
        var q = query(service, account)
        let update = [kSecValueData as String: data]
        var status = SecItemUpdate(q as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            q[kSecValueData as String] = data
            q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            status = SecItemAdd(q as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw map(status) }
    }

    static func delete(service: String, account: String) throws {
        let status = SecItemDelete(query(service, account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw map(status) }
    }
}

/// The core session key (X25519) and the registry key (P-256 in the Secure Enclave).
final class Keys {
    private let lock = NSLock()
    private let account = "primary"

    // MARK: Core key

    private func loadCoreKey() throws -> Curve25519.KeyAgreement.PrivateKey {
        if let raw = try Keychain.read(service: Keychain.coreService, account: account) {
            guard let key = try? Curve25519.KeyAgreement.PrivateKey(rawRepresentation: raw) else {
                throw HelperError("keychain-unavailable", "the core key item is unreadable")
            }
            return key
        }
        let key = Curve25519.KeyAgreement.PrivateKey()
        try Keychain.write(service: Keychain.coreService, account: account, data: key.rawRepresentation)
        return key
    }

    func corePublicKey() throws -> Data {
        lock.lock()
        defer { lock.unlock() }
        return try loadCoreKey().publicKey.rawRepresentation
    }

    /// One X25519 Diffie-Hellman with the core static key. The private key never leaves this process.
    func diffieHellman(peerPub: Data) throws -> Data {
        lock.lock()
        defer { lock.unlock() }
        let key = try loadCoreKey()
        guard let peer = try? Curve25519.KeyAgreement.PublicKey(rawRepresentation: peerPub),
              let secret = try? key.sharedSecretFromKeyAgreement(with: peer)
        else { throw HelperError("bad-args", "peerPub is not a valid X25519 key") }
        let shared = secret.withUnsafeBytes { Data($0) }
        // A low-order peer point yields an all-zero secret: refuse it (RFC 7748 section 6.1).
        if shared.allSatisfy({ $0 == 0 }) { throw HelperError("bad-args", "peerPub is a low-order point") }
        return shared
    }

    /// Revoke all: replace the core key, so every phone must pair again.
    func replaceCoreKey() throws -> Data {
        lock.lock()
        defer { lock.unlock() }
        try Keychain.delete(service: Keychain.coreService, account: account)
        let key = Curve25519.KeyAgreement.PrivateKey()
        try Keychain.write(service: Keychain.coreService, account: account, data: key.rawRepresentation)
        return key.publicKey.rawRepresentation
    }

    // MARK: Registry key (Secure Enclave)

    private func registryBlob() throws -> Data {
        guard SecureEnclave.isAvailable else { throw HelperError("no-secure-enclave", "this Mac has no Secure Enclave") }
        if let blob = try Keychain.read(service: Keychain.registryService, account: account) { return blob }
        var cfError: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(
            nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage, .userPresence], &cfError
        ) else { throw HelperError("no-secure-enclave", "could not create the access control") }
        guard let key = try? SecureEnclave.P256.Signing.PrivateKey(accessControl: access) else {
            throw HelperError("no-secure-enclave", "could not create the registry key in the Secure Enclave")
        }
        try Keychain.write(service: Keychain.registryService, account: account, data: key.dataRepresentation)
        return key.dataRepresentation
    }

    func registryPublicKey() throws -> Data {
        lock.lock()
        defer { lock.unlock() }
        let blob = try registryBlob()
        guard let key = try? SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: blob) else {
            throw HelperError("no-secure-enclave", "the registry key could not be loaded")
        }
        return key.publicKey.x963Representation
    }

    /// Sign with the registry key after the user proved presence (Touch ID or the login password) for exactly this reason.
    /// Returns the raw 64-byte r||s ES256 signature.
    func signRegistryEntry(_ message: Data, reason: String) throws -> Data {
        lock.lock()
        defer { lock.unlock() }
        let blob = try registryBlob()
        let context = LAContext()
        context.localizedReason = reason
        let semaphore = DispatchSemaphore(value: 0)
        var ok = false
        context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { success, _ in
            ok = success
            semaphore.signal()
        }
        semaphore.wait()
        guard ok else { throw HelperError("auth-failed", "authentication was not completed") }
        guard let key = try? SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: blob, authenticationContext: context),
              let signature = try? key.signature(for: message)
        else { throw HelperError("auth-failed", "the Secure Enclave refused to sign") }
        return signature.rawRepresentation
    }
}
