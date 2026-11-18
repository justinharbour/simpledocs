import Foundation
import Testing
@testable import SimpleDocsConnected

@Suite struct SendSpecTests {
    @Test func secureEmailSpecAndValidation() throws {
        var draft = SendDraft()
        draft.channels = .email
        #expect(!draft.problems(hasDocument: true).isEmpty)
        draft.emailAddress = "recipient@example.test"
        draft.emailVerification = "sms"
        #expect(!draft.problems(hasDocument: true).isEmpty)
        draft.emailPhone = "+12125550100"
        #expect(draft.problems(hasDocument: true).isEmpty)
        let spec = try #require(JSONSerialization.jsonObject(with: draft.spec(fallbackTitle: "scan")) as? [String: Any])
        let email = try #require(spec["email"] as? [String: String])
        #expect(email == ["email": "recipient@example.test", "pinChannel": "sms", "phone": "+12125550100"])
        #expect(spec["fax"] == nil && spec["mail"] == nil)
    }
    @Test(arguments: [
        ("(213) 414-7728", "+12134147728"),
        ("213.414.7728", "+12134147728"),
        ("213-414-7728", "+12134147728"),
        ("2134147728", "+12134147728"),
        ("1 213 414 7728", "+12134147728"),
        ("+1 (213) 414-7728", "+12134147728"),
        ("+44 20 7946 0958", "+442079460958"),
    ])
    func normalizesCommonFormats(input: String, expected: String) {
        #expect(PhoneNumber.normalize(input) == expected)
    }

    @Test(arguments: ["", "abc", "123", "(113) 414-7728", "213 114 7728", "+0123456789", "+12", "213-414-7728 ext 5"])
    func rejectsBadNumbers(input: String) {
        #expect(PhoneNumber.normalize(input) == nil)
    }

    @Test func parsesListsAndDropsDuplicates() {
        let parsed = PhoneNumber.parse(list: "(213) 414-7728, 213.414.7728\n+44 20 7946 0958; nope\n\n")
        #expect(parsed.numbers == ["+12134147728", "+442079460958"])
        #expect(parsed.invalid == ["nope"])
    }

    @Test func displaysUSNumbersReadably() {
        #expect(PhoneNumber.display("+12134147728") == "(213) 414-7728")
        #expect(PhoneNumber.display("+442079460958") == "+442079460958")
    }

    @Test func statusWordingNeverClaimsDeliveryForAcceptance() {
        #expect(DeliveryStatus.label("accepted") == "Accepted by provider")
        #expect(DeliveryStatus.label("completed") == "Completed by PostGrid")
        #expect(DeliveryStatus.label("unheard") == "New")
        #expect(DeliveryStatus.label("something_new") == "Something New")
        #expect(DeliveryStatus.note(channel: "fax", status: "accepted")?.contains("not delivered") == true)
        #expect(DeliveryStatus.note(channel: "mail", status: "completed")?.contains("not a delivery confirmation") == true)
        #expect(DeliveryStatus.note(channel: "fax", status: "delivered") == nil)
        for status in ["delivered", "completed", "failed"] { #expect(DeliveryStatus.isTerminal(status)) }
        for status in ["queued", "submitting", "accepted", "awaiting_approval", "unknown"] { #expect(!DeliveryStatus.isTerminal(status)) }
    }

    private func address(_ draft: inout SendDraft) {
        draft.mailTo.firstName = "Ada"; draft.mailTo.addressLine1 = "1 Main St"; draft.mailTo.city = "Austin"
        draft.mailTo.provinceOrState = "TX"; draft.mailTo.postalOrZip = "78701"
        draft.mailFrom = draft.mailTo
    }

    @Test func problemsListWhatIsMissing() {
        var draft = SendDraft()
        #expect(draft.problems(hasDocument: false) == ["Choose a PDF to send.", "Enter at least one fax number."])
        draft.faxList = "555"
        #expect(draft.problems(hasDocument: true) == ["Not a valid fax number: 555."])
        draft.faxList = "(213) 414-7728"
        #expect(draft.problems(hasDocument: true).isEmpty)
        draft.channels = .both
        #expect(draft.problems(hasDocument: true).count == 2)
        address(&draft)
        #expect(draft.problems(hasDocument: true).isEmpty)
        draft.faxList = (0..<11).map { "21341477\(String(format: "%02d", $0))" }.joined(separator: ",")
        #expect(draft.problems(hasDocument: true).contains { $0.contains("at most 10") })
    }

    @Test func mailOnlyIgnoresFaxNumbers() {
        var draft = SendDraft()
        draft.channels = .mail
        address(&draft)
        #expect(draft.problems(hasDocument: true).isEmpty)
    }

    @Test func faxSpecHasNormalizedRecipientsAndCoverDefaultOn() throws {
        var draft = SendDraft()
        draft.faxList = "(213) 414-7728"
        draft.cover.subject = "Hello"
        let day = Date(timeIntervalSince1970: 1_800_000_000)
        let object = try #require(JSONSerialization.jsonObject(with: draft.spec(fallbackTitle: "scan", date: day)) as? [String: Any])
        #expect(object["title"] as? String == "scan")
        #expect(object["mail"] == nil)
        let fax = try #require(object["fax"] as? [String: Any])
        #expect(fax["recipients"] as? [String] == ["+12134147728"])
        let cover = try #require(fax["cover"] as? [String: Any])
        #expect(cover["enabled"] as? Bool == true)
        #expect(cover["subject"] as? String == "Hello")
        #expect((cover["date"] as? String)?.count == 10)
    }

    @Test func mailSpecCarriesOptionsAndOmitsFax() throws {
        var draft = SendDraft()
        draft.channels = .mail
        draft.title = "Letter"
        draft.firstClass = false
        draft.color = true
        address(&draft)
        let object = try #require(JSONSerialization.jsonObject(with: draft.spec(fallbackTitle: "x")) as? [String: Any])
        #expect(object["fax"] == nil)
        #expect(object["title"] as? String == "Letter")
        let mail = try #require(object["mail"] as? [String: Any])
        #expect(mail["mailingClass"] as? String == "standard_class")
        #expect(mail["color"] as? Bool == true && mail["doubleSided"] as? Bool == false)
        #expect((mail["to"] as? [String: Any])?["countryCode"] as? String == "US")
    }

    @Test func channelSelection() {
        #expect(SendChannels.fax.hasFax && !SendChannels.fax.hasMail)
        #expect(!SendChannels.mail.hasFax && SendChannels.mail.hasMail)
        #expect(SendChannels.both.hasFax && SendChannels.both.hasMail)
        #expect(MailMode.test.detail.contains("nothing"))
        #expect(MailMode.live.detail.contains("real letter"))
    }
}
