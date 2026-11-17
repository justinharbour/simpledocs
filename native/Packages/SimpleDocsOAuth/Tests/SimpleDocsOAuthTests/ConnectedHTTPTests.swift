import Foundation
import Testing
import SimpleDocsConnected
@testable import SimpleDocsOAuth

private final class HTTPFixture: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let url = request.url!
        let mode = url.path
        let badMetadata = mode == "/ok" && (request.value(forHTTPHeaderField: "Authorization") != nil || request.value(forHTTPHeaderField: "Cookie") != nil)
        let badWorker = mode.hasPrefix("/api/") && (request.value(forHTTPHeaderField: "Authorization") != "Bearer synthetic" || request.value(forHTTPHeaderField: "Cookie") != nil || request.httpMethod != "GET")
        let status = mode.contains("redirect") ? 302 : (badMetadata || badWorker ? 400 : 200)
        let headers = ["Content-Type": mode.contains("wrong-type") ? "text/html" : "application/json",
                       "Location": "https://other.example.com/escaped"]
        let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        let body = mode.contains("large") ? Data(repeating: 65, count: 65_537) : Data("{}".utf8)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@MainActor @Suite struct ConnectedHTTPTests {
    @Test func actualSessionRejectsBadResponses() async throws {
        let http = ConnectedHTTP(testProtocolClasses: [HTTPFixture.self])
        #expect(try await http.resourceMetadata(url: URL(string: "https://one.example.com/ok")!) == Data("{}".utf8))
        for path in ["redirect", "wrong-type", "large"] {
            await #expect(throws: ConnectedFlowError.self) {
                try await http.resourceMetadata(url: URL(string: "https://one.example.com/\(path)")!)
            }
        }
    }

    @Test func workerRequestCarriesOnlyScopedBearer() async throws {
        var registry = InstanceRegistry()
        let origin = try InstanceOrigin.parse("https://one.example.com").get()
        let linked = try registry.link(AcknowledgedOrigin(origin: origin, acknowledgedDisplay: origin.canonical)!)
        let binding = ContextBinding(try registry.activate(linked.linkID))
        let plan = try WorkerPlanner.plan(.readFax(UUID()), binding: binding, registry: registry)
        let http = ConnectedHTTP(testProtocolClasses: [HTTPFixture.self])
        #expect(try await http.send(plan: plan, bearer: "synthetic") == Data("{}".utf8))
        await #expect(throws: ConnectedFlowError.self) { try await http.send(plan: plan, bearer: "wrong") }
    }
}
