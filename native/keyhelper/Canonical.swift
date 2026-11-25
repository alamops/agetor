import Foundation

/// RFC 8785 canonical JSON over Foundation values ([String: Any], [Any], String, NSNumber, NSNull).
/// Must produce the same bytes as packages/remote-protocol/src/canonical-json.ts; the shared vectors prove it.
enum Canonical {
    struct Failure: Error { let message: String }

    static func serialize(_ value: Any) throws -> String {
        var out = ""
        try write(value, into: &out)
        return out
    }

    private static func write(_ value: Any, into out: inout String) throws {
        switch value {
        case is NSNull:
            out += "null"
        case let s as String:
            out += escape(s)
        case let n as NSNumber:
            if CFGetTypeID(n) == CFBooleanGetTypeID() {
                out += n.boolValue ? "true" : "false"
            } else {
                out += try number(n)
            }
        case let a as [Any]:
            out += "["
            for (i, v) in a.enumerated() {
                if i > 0 { out += "," }
                try write(v, into: &out)
            }
            out += "]"
        case let d as [String: Any]:
            let keys = d.keys.sorted { Array($0.utf16).lexicographicallyPrecedes(Array($1.utf16)) }
            out += "{"
            for (i, k) in keys.enumerated() {
                if i > 0 { out += "," }
                out += escape(k) + ":"
                try write(d[k]!, into: &out)
            }
            out += "}"
        default:
            throw Failure(message: "unsupported value")
        }
    }

    static func escape(_ s: String) -> String {
        var out = "\""
        for u in s.unicodeScalars {
            switch u {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\u{08}": out += "\\b"
            case "\u{09}": out += "\\t"
            case "\u{0A}": out += "\\n"
            case "\u{0C}": out += "\\f"
            case "\u{0D}": out += "\\r"
            default:
                if u.value < 0x20 {
                    out += String(format: "\\u%04x", u.value)
                } else {
                    out.unicodeScalars.append(u)
                }
            }
        }
        return out + "\""
    }

    private static func number(_ n: NSNumber) throws -> String {
        let d = n.doubleValue
        if !d.isFinite { throw Failure(message: "non-finite number") }
        return ecmaNumber(d)
    }

    /// ECMAScript Number::toString (RFC 8785 section 3.2.2.3), built from Swift's shortest round-trip digits.
    static func ecmaNumber(_ value: Double) -> String {
        if value == 0 { return "0" }
        let negative = value < 0
        let text = "\(abs(value))"
        var mantissa = text
        var exp10 = 0
        if let e = text.firstIndex(where: { $0 == "e" || $0 == "E" }) {
            mantissa = String(text[..<e])
            exp10 = Int(text[text.index(after: e)...]) ?? 0
        }
        var intPart = mantissa
        var frac = ""
        if let dot = mantissa.firstIndex(of: ".") {
            intPart = String(mantissa[..<dot])
            frac = String(mantissa[mantissa.index(after: dot)...])
        }
        var digits = Array(intPart + frac)
        var n = intPart.count + exp10
        while digits.count > 1 && digits.first == "0" {
            digits.removeFirst()
            n -= 1
        }
        while digits.count > 1 && digits.last == "0" { digits.removeLast() }
        let k = digits.count
        var s: String
        if k <= n && n <= 21 {
            s = String(digits) + String(repeating: "0", count: n - k)
        } else if 0 < n && n <= 21 {
            s = String(digits[0..<n]) + "." + String(digits[n...])
        } else if -6 < n && n <= 0 {
            s = "0." + String(repeating: "0", count: -n) + String(digits)
        } else {
            let e = n - 1
            let sign = e < 0 ? "-" : "+"
            if k == 1 {
                s = String(digits) + "e" + sign + String(abs(e))
            } else {
                s = String(digits[0]) + "." + String(digits[1...]) + "e" + sign + String(abs(e))
            }
        }
        return negative ? "-" + s : s
    }
}

enum Hex {
    static func encode(_ d: Data) -> String { d.map { String(format: "%02x", $0) }.joined() }

    /// Strict lowercase hex of exactly `bytes` bytes (or any even length when nil).
    static func decode(_ s: String, bytes: Int? = nil) -> Data? {
        let chars = Array(s.utf8)
        if chars.count % 2 != 0 { return nil }
        if let b = bytes, chars.count != b * 2 { return nil }
        var out = Data(capacity: chars.count / 2)
        func nibble(_ c: UInt8) -> UInt8? {
            switch c {
            case 48...57: return c - 48
            case 97...102: return c - 87
            default: return nil
            }
        }
        var i = 0
        while i < chars.count {
            guard let h = nibble(chars[i]), let l = nibble(chars[i + 1]) else { return nil }
            out.append(h << 4 | l)
            i += 2
        }
        return out
    }
}

enum Base64URL {
    static func encode(_ d: Data) -> String {
        d.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}
