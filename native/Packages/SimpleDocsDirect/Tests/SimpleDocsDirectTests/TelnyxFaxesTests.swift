import Foundation
import XCTest
@testable import SimpleDocsDirect

final class TelnyxFaxesTests: XCTestCase {
    func testReadsOnlyFirstPageWithBearerAndNoSideEffects() async throws {
        let client = TelnyxFaxes { request in
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.url?.host, "api.telnyx.com")
            XCTAssertEqual(request.url?.path, "/v2/faxes")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer synthetic-key")
            XCTAssertNil(request.httpBody)
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (Data(#"{"data":[{"id":"synthetic","status":"queued","direction":"outbound"}]}"#.utf8), response)
        }
        let records = try await client.list(key: "synthetic-key")
        XCTAssertEqual(records.count, 1)
        XCTAssertEqual(records.first?.status, "queued")
    }

    func testRejectsKeyAndMapsErrorsWithoutLeakingResponse() async throws {
        let client = TelnyxFaxes { request in
            let response = HTTPURLResponse(url: request.url!, statusCode: 403, httpVersion: nil, headerFields: nil)!
            return (Data("secret response".utf8), response)
        }
        do { _ = try await client.list(key: "bad\nkey"); XCTFail("invalid key accepted") }
        catch { XCTAssertEqual(error as? DirectFaxError, .invalidKey) }
        do { _ = try await client.list(key: "synthetic-key"); XCTFail("403 accepted") }
        catch { XCTAssertEqual(error as? DirectFaxError, .unauthorized) }
    }

    func testMalformedOrRedirectResponseFailsClosed() async throws {
        for status in [200, 302] {
            let client = TelnyxFaxes { request in
                (Data("not json".utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
            }
            do { _ = try await client.list(key: "synthetic-key"); XCTFail("unexpected success") }
            catch { XCTAssertEqual(error as? DirectFaxError, status == 200 ? .invalidResponse : .unavailable) }
        }
    }
}
