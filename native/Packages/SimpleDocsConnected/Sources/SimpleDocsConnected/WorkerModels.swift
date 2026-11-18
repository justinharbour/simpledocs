import Foundation

/// Codable shapes of the owner Worker's JSON API. Nothing here performs I/O.
public enum RecordType: String, Codable, Sendable {
    case transmission, inboundFax = "inbound_fax", recording, other

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = RecordType(rawValue: raw) ?? .other
    }
}

public struct ChannelStatus: Codable, Sendable, Hashable {
    public let id: String?
    public let channel: String
    public let status: String
}

public struct RecordItem: Codable, Sendable, Hashable, Identifiable {
    public let type: RecordType
    public let id: String
    public let title: String
    public let createdAt: String
    public let updatedAt: String?
    public let channels: [ChannelStatus]
    public let pageCount: Int?
    public let envelopeNumber: String?
    public let previewUrl: String?
    public let previewType: String?
    public let kind: String?
    public let direction: String?
    public let fromNumber: String?
    public let toNumber: String?
    public let durationSecs: Int?
    public let transcript: String?

    public var date: Date? { WorkerDate.parse(createdAt) }
    public var rowID: String { "\(type.rawValue):\(id)" }
    /// True while any delivery is still moving. A letter waiting for approval is not polled.
    public var isActive: Bool {
        type == .transmission && channels.contains { !DeliveryStatus.isTerminal($0.status) && $0.status != "awaiting_approval" }
    }
}

public struct RecordsResponse: Codable, Sendable { public let records: [RecordItem] }

public struct TimelineStep: Codable, Sendable, Hashable {
    public let at: String
    public let status: String
    public let detail: String?
}

public struct DeliveryDetail: Codable, Sendable, Hashable, Identifiable {
    public let id: String
    public let channel: String
    public let recipient: String
    public let status: String
    public let providerStatus: String?
    public let error: String?
    public let needsApproval: Bool
    public let coverUrl: String?
    public let timeline: [TimelineStep]
}

public struct TransmissionDetail: Codable, Sendable, Hashable, Identifiable {
    public let id: String
    public let envelopeNumber: String?
    public let documents: [EnvelopeDocument]?
    public let title: String
    public let pageCount: Int
    public let createdAt: String
    public let updatedAt: String
    public let documentUrl: String
    public let settled: Bool
    public let deliveries: [DeliveryDetail]

    public var isActive: Bool {
        deliveries.contains { !DeliveryStatus.isTerminal($0.status) && !$0.needsApproval }
    }
}

public struct EnvelopeDocument: Codable, Sendable, Hashable, Identifiable {
    public let position: Int
    public let number: String
    public let name: String
    public let pageCount: Int
    public var id: Int { position }
}

public struct CreatedDelivery: Codable, Sendable, Hashable { public let id: String; public let channel: String; public let status: String }
public struct CreatedTransmission: Codable, Sendable {
    public let id: String
    public let envelopeNumber: String?
    public let deliveries: [CreatedDelivery]
}

public struct FaxReview: Decodable, Sendable {
    public let recipient: String
    public let from: String
    public let status: String
    public let reviewHash: String
    public let packetSha256: String
    public let packetUrl: String
}

public struct RecentRecipients: Decodable, Sendable {
    public let fax: [String]
    public let mail: [MailContact]
}

public struct MailReview: Codable, Sendable {
    public let mode: String
    public let reviewHash: String
    public let pageCount: Int
    public let status: String
    public let available: Bool
    public let notice: String
    public let summary: MailReviewSummary?
}

public struct MailReviewSummary: Codable, Sendable {
    public let to: MailContact
    public let from: MailContact
    public let color: Bool
    public let doubleSided: Bool
    public let mailingClass: String
}

public struct MailApproval: Encodable, Sendable {
    public let confirmed = true
    public let mode: String
    public let reviewHash: String
    public init(mode: String, reviewHash: String) { self.mode = mode; self.reviewHash = reviewHash }
}

public struct MailContact: Codable, Sendable, Equatable {
    public var firstName = ""
    public var lastName = ""
    public var addressLine1 = ""
    public var addressLine2 = ""
    public var city = ""
    public var provinceOrState = ""
    public var postalOrZip = ""
    public var countryCode = "US"

    public init() {}

    enum CodingKeys: String, CodingKey { case firstName, lastName, addressLine1, addressLine2, city, provinceOrState, postalOrZip, countryCode }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        firstName = try c.decodeIfPresent(String.self, forKey: .firstName) ?? ""
        lastName = try c.decodeIfPresent(String.self, forKey: .lastName) ?? ""
        addressLine1 = try c.decodeIfPresent(String.self, forKey: .addressLine1) ?? ""
        addressLine2 = try c.decodeIfPresent(String.self, forKey: .addressLine2) ?? ""
        city = try c.decodeIfPresent(String.self, forKey: .city) ?? ""
        provinceOrState = try c.decodeIfPresent(String.self, forKey: .provinceOrState) ?? ""
        postalOrZip = try c.decodeIfPresent(String.self, forKey: .postalOrZip) ?? ""
        countryCode = try c.decodeIfPresent(String.self, forKey: .countryCode) ?? "US"
    }

    /// Optional fields are left out when empty because the Worker rejects blank strings.
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(firstName.trimmed, forKey: .firstName)
        if !lastName.trimmed.isEmpty { try c.encode(lastName.trimmed, forKey: .lastName) }
        try c.encode(addressLine1.trimmed, forKey: .addressLine1)
        if !addressLine2.trimmed.isEmpty { try c.encode(addressLine2.trimmed, forKey: .addressLine2) }
        try c.encode(city.trimmed, forKey: .city)
        try c.encode(provinceOrState.trimmed.uppercased(), forKey: .provinceOrState)
        try c.encode(postalOrZip.trimmed, forKey: .postalOrZip)
        try c.encode("US", forKey: .countryCode)
    }

    public var isBlank: Bool { self == MailContact() }

    /// A short reason the address would be refused, or nil when it looks complete.
    public func problem(_ label: String) -> String? {
        if firstName.trimmed.isEmpty { return "\(label): enter a name." }
        if addressLine1.trimmed.isEmpty { return "\(label): enter a street address." }
        if city.trimmed.isEmpty { return "\(label): enter a city." }
        if provinceOrState.trimmed.range(of: "^[A-Za-z]{2}$", options: .regularExpression) == nil { return "\(label): use a two-letter state, like TX." }
        if postalOrZip.trimmed.range(of: "^\\d{5}(-\\d{4})?$", options: .regularExpression) == nil { return "\(label): use a 5-digit ZIP code." }
        return nil
    }

    public var oneLine: String {
        let name = [firstName, lastName].map(\.trimmed).filter { !$0.isEmpty }.joined(separator: " ")
        let street = [addressLine1, addressLine2].map(\.trimmed).filter { !$0.isEmpty }.joined(separator: ", ")
        return "\(name), \(street), \(city.trimmed) \(provinceOrState.trimmed.uppercased()) \(postalOrZip.trimmed)"
    }
}

public struct WorkerSettings: Codable, Sendable, Equatable {
    public let senderName: String
    public let mailFrom: MailContact?
    public let faxFrom: String?
}

public struct SettingsUpdate: Encodable, Sendable {
    public var senderName: String?
    public var mailFrom: MailContact?
    public init(senderName: String? = nil, mailFrom: MailContact? = nil) { self.senderName = senderName; self.mailFrom = mailFrom }
}

public struct CallItem: Codable, Sendable, Hashable, Identifiable {
    public let id: String
    public let direction: String
    public let from: String?
    public let to: String?
    public let startedAt: String?
    public let answeredAt: String?
    public let endedAt: String?
    public let durationSecs: Int?
    public let hangupCause: String?
    public let outcome: String

    public var date: Date? { startedAt.flatMap(WorkerDate.parse) }
    /// The number to dial back: the caller for inbound calls, the callee for outbound ones.
    public var otherParty: String? { direction == "inbound" ? from : to }
}
public struct CallsResponse: Codable, Sendable { public let calls: [CallItem] }

public struct Recording: Codable, Sendable, Hashable, Identifiable {
    public let recordingId: String
    public let archivedAt: String
    public let kind: String?
    public let direction: String?
    public let fromNumber: String?
    public let toNumber: String?
    public let durationSecs: Int?
    public var heardAt: String?
    public let transcript: String?

    public var id: String { recordingId }
    public var isNew: Bool { heardAt == nil }
    public var date: Date? { WorkerDate.parse(archivedAt) }
    public var path: String { "/api/voice/recordings/\(recordingId)" }

    enum CodingKeys: String, CodingKey {
        case recordingId = "recording_id", archivedAt = "archived_at", kind, direction
        case fromNumber = "from_number", toNumber = "to_number", durationSecs = "duration_secs"
        case heardAt = "heard_at", transcript
    }
}
public struct RecordingsResponse: Codable, Sendable { public let recordings: [Recording] }

/// Expected shape of GET/PUT /api/settings/voicemail. The route is not on every Worker build yet.
public struct VoicemailSettings: Codable, Sendable, Equatable {
    public var greeting: String
    public var voice: String
    public var serviceLevel: String

    public init(greeting: String, voice: String, serviceLevel: String) {
        self.greeting = greeting; self.voice = voice; self.serviceLevel = serviceLevel
    }

    enum CodingKeys: String, CodingKey { case greeting, voice, serviceLevel = "service_level" }
}

public struct VoicePreset: Sendable, Hashable, Identifiable {
    public let id: String
    public let label: String
    public let serviceLevel: String

    public static let kokoro = VoicePreset(id: "Telnyx.KokoroTTS.af", label: "Kokoro (recommended)", serviceLevel: "basic")
    public static let all: [VoicePreset] = [
        kokoro,
        VoicePreset(id: "AWS.Polly.Joanna-Neural", label: "Polly Joanna, neural", serviceLevel: "premium"),
        VoicePreset(id: "AWS.Polly.Joanna", label: "Polly Joanna", serviceLevel: "basic"),
        VoicePreset(id: "female", label: "Legacy female", serviceLevel: "basic"),
    ]
    public static func preset(for voice: String) -> VoicePreset? { all.first { $0.id == voice } }
    public static let greetingLimit = 1000
}

public struct WorkerErrorBody: Decodable, Sendable { public let error: String? }

extension String {
    public var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}

/// The Worker sends ISO 8601 for most fields and "YYYY-MM-DD HH:MM:SS" (UTC) for archived recordings.
public enum WorkerDate {
    public static func parse(_ value: String) -> Date? {
        if value.range(of: "^\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d$", options: .regularExpression) != nil {
            return parse(value.replacingOccurrences(of: " ", with: "T") + "Z")
        }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        if let date = plain.date(from: value) { return date }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: value)
    }
}
