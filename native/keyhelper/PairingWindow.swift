import AppKit
import CoreImage
import CryptoKit
import Foundation

/// Derivations shared with packages/remote-protocol/src/derive.ts. The shared vectors prove both sides agree.
enum Derive {
    static func hkdf(_ ikm: Data, info: String, count: Int) -> Data {
        let key = HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: ikm), salt: Data(), info: Data(info.utf8), outputByteCount: count)
        return key.withUnsafeBytes { Data($0) }
    }

    /// Six digits: u32be(HKDF(handshake hash, "agetor-sas/1")[0..4]) mod 1,000,000.
    static func sas(handshakeHash: Data) -> String {
        let okm = hkdf(handshakeHash, info: "agetor-sas/1", count: 32)
        let n = okm.prefix(4).reduce(UInt32(0)) { ($0 << 8) | UInt32($1) } % 1_000_000
        return String(format: "%06u", n)
    }

    static func pairingMailboxKey(_ secret: Data) -> Data { hkdf(secret, info: "agetor-pairing/1", count: 32) }

    static func mailboxId(_ key: Data) -> Data { Data(SHA256.hash(data: key).prefix(16)) }
}

/// Strip control, bidi and zero-width characters and cap at 40 characters (the core cleans too; both do, because the name
/// comes from the phone and is drawn here as plain text).
func cleanDeviceName(_ s: String) -> String {
    var out = ""
    for u in s.unicodeScalars {
        let v = u.value
        let isControl = v < 0x20 || (v >= 0x7F && v <= 0x9F)
        let isInvisible = (v >= 0x200B && v <= 0x200F) || (v >= 0x202A && v <= 0x202E) || (v >= 0x2060 && v <= 0x2064) || (v >= 0x2066 && v <= 0x2069) || v == 0xFEFF || v == 0x00AD
        if !isControl && !isInvisible { out.unicodeScalars.append(u) }
    }
    let trimmed = out.trimmingCharacters(in: .whitespaces)
    return String(trimmed.prefix(40))
}

struct PairRequest {
    let handshakeHash: Data
    let deviceId: String
    let name: String
    let platform: String
    let appVersion: String
    let sessionPub: Data
    let approvePub: Data
    let pushPub: Data
    let enrolledAt: Int64

    init(args: [String: Any]) throws {
        handshakeHash = try Args.hex(args, "handshakeHash", bytes: 32)
        deviceId = Hex.encode(try Args.hex(args, "deviceId", bytes: 16))
        name = cleanDeviceName(try Args.string(args, "name", max: 400))
        if name.isEmpty { throw HelperError("bad-args", "name is empty after cleaning") }
        platform = try Args.string(args, "platform", max: 16)
        guard platform == "ios" || platform == "android" else { throw HelperError("bad-args", "platform must be ios or android") }
        appVersion = try Args.string(args, "appVersion", max: 64)
        sessionPub = try Args.hex(args, "sessionPub", bytes: 65)
        approvePub = try Args.hex(args, "approvePub", bytes: 65)
        pushPub = try Args.hex(args, "pushPub", bytes: 32)
        guard sessionPub.first == 4, approvePub.first == 4 else { throw HelperError("bad-args", "P-256 keys must be uncompressed") }
        enrolledAt = try Args.int(args, "enrolledAt")
    }
}

struct PairResult {
    let level: String
    let entry: String
    let signature: Data
}

private let levelChoices: [(id: String, title: String, detail: String)] = [
    ("respond", "Respond", "Read tasks, answer questions, approve plans and stop runs."),
    ("operate", "Operate", "Everything in Respond, plus switching accounts and previewing any file on this Mac."),
    ("configure", "Configure", "Everything in Operate, plus typing into a task's terminal as you."),
]

/// The only place a device can ever be added. It draws no text from an agent: only the phone's cleaned name, as plain text.
final class PairingController: NSObject, NSWindowDelegate {
    static let shared = PairingController()

    private var window: NSWindow?
    private var expiryTimer: Timer?
    private var expiresAt: Int64 = 0
    private var pairingSecret: Data?

    private var statusLabel = NSTextField(labelWithString: "")
    private var qrView = NSImageView()
    private var nameLabel = NSTextField(labelWithString: "")
    private var codeField = NSTextField()
    private var levelPopup = NSPopUpButton()
    private var levelDetail = NSTextField(wrappingLabelWithString: "")
    private var pairButton = NSButton(title: "Add phone", target: nil, action: nil)
    private var entryStack = NSStackView()

    private var pending: (request: PairRequest, keys: Keys, revocation: Revocation, done: (Result<PairResult, HelperError>) -> Void)?
    private var wrongCodes = 0
    private var finishing = false

    // MARK: Begin

    func begin(relayUrl: String, macName: String, expiresAt: Int64, corePub: Data) throws -> (secret: Data, qr: String) {
        if window != nil { throw HelperError("busy", "a pairing window is already open") }
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        guard expiresAt > now, expiresAt - now <= 10 * 60 * 1000 else { throw HelperError("bad-args", "expiresAt must be within 10 minutes") }

        var secret = Data(count: 32)
        let status = secret.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }
        guard status == errSecSuccess else { throw HelperError("internal", "no randomness") }
        let mailbox = Derive.mailboxId(Derive.pairingMailboxKey(secret))
        let payload: [String: Any] = [
            "fmt": 1,
            "corePub": Hex.encode(corePub),
            "relayUrl": relayUrl,
            "mailbox": Hex.encode(mailbox),
            "pairingSecret": Hex.encode(secret),
            "expiresAt": expiresAt,
        ]
        let qr: String
        do { qr = Base64URL.encode(Data(try Canonical.serialize(payload).utf8)) } catch { throw HelperError("internal", "could not encode the QR payload") }

        self.expiresAt = expiresAt
        self.pairingSecret = secret
        self.wrongCodes = 0
        self.finishing = false
        buildWindow(qr: qr, macName: macName)
        let interval = max(0.1, Double(expiresAt - now) / 1000.0)
        expiryTimer = Timer.scheduledTimer(withTimeInterval: interval, repeats: false) { [weak self] _ in self?.cancel(reason: "expired") }
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
        return (secret, qr)
    }

    private func buildWindow(qr: String, macName: String) {
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 440, height: 640), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        w.title = "Pair a Phone"
        w.isReleasedWhenClosed = false
        w.delegate = self
        w.center()

        let heading = NSTextField(labelWithString: "Pair a phone with \(cleanDeviceName(macName))")
        heading.font = .boldSystemFont(ofSize: 15)
        let warning = NSTextField(wrappingLabelWithString: "Only continue if you chose Pair a Phone from Agetor's menu.")
        warning.textColor = .secondaryLabelColor

        qrView.image = Self.qrImage(qr)
        qrView.imageScaling = .scaleProportionallyUpOrDown
        qrView.widthAnchor.constraint(equalToConstant: 220).isActive = true
        qrView.heightAnchor.constraint(equalToConstant: 220).isActive = true

        statusLabel.stringValue = "Scan this code with the Agetor app. It works for 2 minutes."
        statusLabel.lineBreakMode = .byWordWrapping
        statusLabel.maximumNumberOfLines = 2

        // Shown once the phone has connected.
        nameLabel.font = .boldSystemFont(ofSize: 13)
        codeField.placeholderString = "6-digit code shown on the phone"
        codeField.alignment = .center
        codeField.font = .monospacedDigitSystemFont(ofSize: 22, weight: .medium)
        codeField.widthAnchor.constraint(equalToConstant: 260).isActive = true
        levelPopup.removeAllItems()
        for c in levelChoices { levelPopup.addItem(withTitle: c.title) }
        levelPopup.selectItem(at: 0)
        levelPopup.target = self
        levelPopup.action = #selector(levelChanged)
        levelDetail.stringValue = levelChoices[0].detail
        levelDetail.textColor = .secondaryLabelColor
        pairButton.target = self
        pairButton.action = #selector(pairClicked)
        pairButton.keyEquivalent = "\r"
        let cancelButton = NSButton(title: "Cancel", target: self, action: #selector(cancelClicked))
        let buttons = NSStackView(views: [cancelButton, pairButton])
        buttons.spacing = 12

        let entryLabel = NSTextField(wrappingLabelWithString: "Type the code the phone shows, choose what this phone may do, then confirm with Touch ID.")
        entryStack = NSStackView(views: [nameLabel, entryLabel, codeField, levelPopup, levelDetail, buttons])
        entryStack.orientation = .vertical
        entryStack.alignment = .centerX
        entryStack.spacing = 10
        entryStack.isHidden = true

        let stack = NSStackView(views: [heading, warning, qrView, statusLabel, entryStack])
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 14
        stack.edgeInsets = NSEdgeInsets(top: 24, left: 24, bottom: 24, right: 24)
        stack.translatesAutoresizingMaskIntoConstraints = false
        w.contentView = NSView()
        w.contentView!.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: w.contentView!.topAnchor),
            stack.leadingAnchor.constraint(equalTo: w.contentView!.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: w.contentView!.trailingAnchor),
        ])
        window = w
    }

    private static func qrImage(_ text: String) -> NSImage? {
        guard let filter = CIFilter(name: "CIQRCodeGenerator") else { return nil }
        filter.setValue(Data(text.utf8), forKey: "inputMessage")
        filter.setValue("M", forKey: "inputCorrectionLevel")
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)) else { return nil }
        let rep = NSCIImageRep(ciImage: output)
        let image = NSImage(size: rep.size)
        image.addRepresentation(rep)
        return image
    }

    // MARK: Complete

    func complete(request: PairRequest, keys: Keys, revocation: Revocation, done: @escaping (Result<PairResult, HelperError>) -> Void) {
        guard window != nil, pairingSecret != nil else { return done(.failure(HelperError("cancelled", "no pairing window is open"))) }
        guard pending == nil else { return done(.failure(HelperError("busy", "a pairing is already in progress"))) }
        if Int64(Date().timeIntervalSince1970 * 1000) >= expiresAt { return done(.failure(HelperError("expired", "the pairing window expired"))) }
        pending = (request, keys, revocation, done)
        // Plain text only: the name is drawn by an NSTextField label, never as attributed or markup text.
        nameLabel.stringValue = "\(request.name)  (\(request.platform == "ios" ? "iPhone" : "Android"))"
        statusLabel.stringValue = "A phone connected."
        qrView.isHidden = true
        entryStack.isHidden = false
        codeField.stringValue = ""
        window?.makeFirstResponder(codeField)
    }

    @objc private func levelChanged() {
        levelDetail.stringValue = levelChoices[max(0, levelPopup.indexOfSelectedItem)].detail
    }

    @objc private func cancelClicked() { cancel(reason: "cancelled") }

    @objc private func pairClicked() {
        guard let p = pending, !finishing else { return }
        let typed = codeField.stringValue.trimmingCharacters(in: .whitespaces)
        let expected = Derive.sas(handshakeHash: p.request.handshakeHash)
        if Int64(Date().timeIntervalSince1970 * 1000) >= expiresAt { return cancel(reason: "expired") }
        guard typed == expected else {
            wrongCodes += 1
            if wrongCodes >= 3 { return cancel(reason: "wrong-code") }
            statusLabel.stringValue = "That code does not match. \(3 - wrongCodes) \(3 - wrongCodes == 1 ? "try" : "tries") left."
            codeField.stringValue = ""
            return
        }
        let level = levelChoices[max(0, levelPopup.indexOfSelectedItem)].id
        if level == "configure" && !confirmConfigure(name: p.request.name) { return }
        finishing = true
        pairButton.isEnabled = false
        statusLabel.stringValue = "Waiting for Touch ID…"
        let request = p.request
        DispatchQueue.global().async { [weak self] in
            let result: Result<PairResult, HelperError>
            do {
                result = .success(try Self.signEntry(request: request, level: level, keys: p.keys, revocation: p.revocation))
            } catch let e as HelperError {
                result = .failure(e)
            } catch {
                result = .failure(HelperError("internal", "signing failed"))
            }
            DispatchQueue.main.async { self?.finish(result) }
        }
    }

    private func confirmConfigure(name: String) -> Bool {
        let alert = NSAlert()
        alert.messageText = "Give \"\(name)\" Configure access?"
        alert.informativeText = "A Configure phone can attach to a task's terminal and type anything you could, with your full privileges. Choose Configure only for a phone you carry yourself."
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Cancel")
        alert.addButton(withTitle: "Allow Configure")
        return alert.runModal() == .alertSecondButtonReturn
    }

    /// Canonical JSON of exactly {id, name, platform, session_pub, approve_pub, push_pub, level, enrolled_at}, signed by the
    /// Secure Enclave registry key after Touch ID. The id is recorded as signed BEFORE the signature leaves the helper.
    private static func signEntry(request: PairRequest, level: String, keys: Keys, revocation: Revocation) throws -> PairResult {
        let entry: [String: Any] = [
            "id": request.deviceId,
            "name": request.name,
            "platform": request.platform,
            "session_pub": Hex.encode(request.sessionPub),
            "approve_pub": Hex.encode(request.approvePub),
            "push_pub": Hex.encode(request.pushPub),
            "level": level,
            "enrolled_at": request.enrolledAt,
        ]
        let canonical = try Canonical.serialize(entry)
        try revocation.recordSigned(id: request.deviceId)
        let signature = try keys.signRegistryEntry(Data(canonical.utf8), reason: "Add '\(request.name)' to Agetor")
        return PairResult(level: level, entry: canonical, signature: signature)
    }

    private func finish(_ result: Result<PairResult, HelperError>) {
        let done = pending?.done
        pending = nil
        close()
        done?(result)
    }

    func cancel(reason: String) {
        guard window != nil else { return }
        if let done = pending?.done {
            pending = nil
            close()
            done(.failure(HelperError(reason, reason == "expired" ? "the pairing window expired" : reason == "wrong-code" ? "the code was wrong three times" : "pairing was cancelled")))
        } else {
            close()
        }
        Output.event("pairing-cancelled")
    }

    private func close() {
        expiryTimer?.invalidate()
        expiryTimer = nil
        pairingSecret = nil
        let w = window
        window = nil
        w?.delegate = nil
        w?.orderOut(nil)
        w?.close()
    }

    func windowWillClose(_ notification: Notification) {
        // The user closed the window with the red button.
        let hadWindow = window != nil
        let done = pending?.done
        pending = nil
        expiryTimer?.invalidate()
        pairingSecret = nil
        window = nil
        if let done = done { done(.failure(HelperError("cancelled", "the pairing window was closed"))) }
        if hadWindow { Output.event("window-closed") }
    }
}
