import Foundation

/// Status wording matches the web app. "Accepted" and "completed" are what a provider said, never delivery.
public enum DeliveryStatus {
    public static func label(_ status: String) -> String {
        switch status {
        case "awaiting_approval": "Awaiting confirmation"
        case "queued": "Queued"
        case "submitting": "Submitting"
        case "accepted": "Accepted by provider"
        case "delivered": "Delivered"
        case "completed": "Completed by PostGrid"
        case "failed": "Failed"
        case "unknown": "Outcome unknown"
        case "received": "Received"
        case "heard": "Heard"
        case "unheard": "New"
        default: status.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }

    public static func isTerminal(_ status: String) -> Bool {
        ["delivered", "completed", "failed"].contains(status)
    }

    public static func channelLabel(_ channel: String) -> String {
        switch channel {
        case "fax": "Fax"
        case "mail": "Paper mail"
        case "voice": "Voicemail"
        default: channel.capitalized
        }
    }

    /// Plain-language explanation of what a status does and does not mean.
    public static func note(channel: String, status: String, needsApproval: Bool = false) -> String? {
        if needsApproval || status == "awaiting_approval" { return "This letter was not confirmed, so nothing was mailed." }
        switch (status, channel) {
        case ("queued", _): return "Waiting its turn. It has not been sent yet."
        case ("accepted", "fax"): return "Telnyx has the fax. It is not delivered until the receiving machine confirms."
        case ("accepted", _): return "PostGrid has the letter. It is not printed or mailed yet."
        case ("completed", _): return "PostGrid reports the letter as completed. That is not a delivery confirmation."
        default: return nil
        }
    }
}

/// Same rules as the Worker's phone.mjs: common US formats and "+" international numbers.
public enum PhoneNumber {
    public static func normalize(_ input: String) -> String? {
        let s = input.trimmed
        guard !s.isEmpty, s.range(of: "^\\+?[\\d\\s().-]+$", options: .regularExpression) != nil else { return nil }
        let digits = s.filter(\.isASCIIDigit)
        func matches(_ pattern: String) -> Bool { digits.range(of: pattern, options: .regularExpression) != nil }
        if s.hasPrefix("+") { return matches("^[1-9]\\d{6,14}$") ? "+" + digits : nil }
        if matches("^[2-9]\\d{2}[2-9]\\d{6}$") { return "+1" + digits }
        if matches("^1[2-9]\\d{2}[2-9]\\d{6}$") { return "+" + digits }
        return nil
    }

    public struct Parsed: Equatable, Sendable {
        public var numbers: [String] = []
        public var invalid: [String] = []
    }

    /// Splits on newlines, commas and semicolons, drops duplicates and keeps the bad entries for display.
    public static func parse(list: String) -> Parsed {
        var result = Parsed()
        for piece in list.split(whereSeparator: { "\n,;".contains($0) }) {
            let raw = String(piece).trimmed
            guard !raw.isEmpty else { continue }
            if let number = normalize(raw) { if !result.numbers.contains(number) { result.numbers.append(number) } }
            else { result.invalid.append(raw) }
        }
        return result
    }

    /// 10-digit US numbers read better as (213) 414-7728.
    public static func display(_ e164: String) -> String {
        guard e164.hasPrefix("+1"), e164.count == 12 else { return e164 }
        let d = Array(e164.dropFirst(2))
        return "(\(String(d[0..<3]))) \(String(d[3..<6]))-\(String(d[6..<10]))"
    }
}

private extension Character { var isASCIIDigit: Bool { ("0"..."9").contains(self) } }

public enum SendChannels: String, CaseIterable, Sendable, Identifiable {
    case fax, mail, both
    public var id: String { rawValue }
    public var label: String { switch self { case .fax: "Fax"; case .mail: "Paper mail"; case .both: "Fax and mail" } }
    public var hasFax: Bool { self != .mail }
    public var hasMail: Bool { self != .fax }
}

public enum MailMode: String, CaseIterable, Sendable, Identifiable {
    case test, live
    public var id: String { rawValue }
    public var label: String { self == .test ? "Test" : "Live" }
    public var detail: String {
        self == .test ? "PostGrid prints nothing and mails nothing. Use this to check the flow."
                      : "PostGrid prints and mails a real letter. This costs money."
    }
}

public struct CoverOptions: Sendable, Equatable {
    public var enabled = true
    public var includeNumbers = false
    public var to = ""
    public var from = ""
    public var subject = ""
    public var message = ""
    public init() {}
}

public struct SendDraft: Sendable, Equatable {
    public var title = ""
    public var channels = SendChannels.fax
    public var faxList = ""
    public var cover = CoverOptions()
    public var numberDocumentPages = false
    public var mailTo = MailContact()
    public var mailFrom = MailContact()
    public var color = false
    public var doubleSided = false
    public var firstClass = true
    public var mode = MailMode.test

    public init() {}

    public var fax: PhoneNumber.Parsed { PhoneNumber.parse(list: faxList) }

    /// What to fix before the review step, in the order a person fills the form.
    public func problems(hasDocument: Bool) -> [String] {
        var found: [String] = []
        if !hasDocument { found.append("Choose a PDF to send.") }
        if channels.hasFax {
            let parsed = fax
            if parsed.numbers.isEmpty && parsed.invalid.isEmpty { found.append("Enter at least one fax number.") }
            if !parsed.invalid.isEmpty { found.append("Not a valid fax number: \(parsed.invalid.joined(separator: ", ")).") }
            if parsed.numbers.count > 10 { found.append("Send to at most 10 fax numbers at a time.") }
        }
        if channels.hasMail {
            if let issue = mailTo.problem("Mailing address") { found.append(issue) }
            if let issue = mailFrom.problem("Return address") { found.append(issue) }
        }
        return found
    }

    /// The JSON the Worker expects in the `spec` multipart field.
    public func spec(fallbackTitle: String, date: Date = Date()) throws -> Data {
        struct Cover: Encodable { let enabled: Bool; let includeNumbers: Bool; let to: String; let from: String; let subject: String; let message: String; let date: String }
        struct Fax: Encodable { let recipients: [String]; let cover: Cover }
        struct Mail: Encodable { let to: MailContact; let from: MailContact; let color: Bool; let doubleSided: Bool; let mailingClass: String }
        struct Spec: Encodable { let title: String; let fax: Fax?; let mail: Mail? }
        let day = DateFormatter()
        day.locale = Locale(identifier: "en_US_POSIX")
        day.dateFormat = "yyyy-MM-dd"
        let name = title.trimmed.isEmpty ? fallbackTitle : title.trimmed
        let fax = channels.hasFax ? Fax(recipients: self.fax.numbers, cover: Cover(
            enabled: cover.enabled, includeNumbers: cover.enabled && cover.includeNumbers, to: cover.to.trimmed, from: cover.from.trimmed,
            subject: cover.subject.trimmed, message: cover.message.trimmed, date: day.string(from: date))) : nil
        let mail = channels.hasMail ? Mail(to: mailTo, from: mailFrom, color: color, doubleSided: doubleSided,
                                          mailingClass: firstClass ? "first_class" : "standard_class") : nil
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(Spec(title: name, fax: fax, mail: mail))
    }
}
