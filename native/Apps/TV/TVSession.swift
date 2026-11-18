import AudioToolbox
import Foundation
import Observation

@MainActor
@Observable
final class TVSession {
    private(set) var token: String? = TVTokenStore.load()
    private(set) var pairing: TVPairingCode?
    private(set) var dashboard: TVDashboard?
    private(set) var dashboardFailed = false
    private(set) var lastUpdated: Date?

    private let client = TVClient()

    func runPairing() async {
        while !Task.isCancelled && token == nil {
            do {
                let code = try await client.start(deviceName: "Apple TV")
                pairing = code
                var interval = Double(code.interval)
                let deadline = Date().addingTimeInterval(Double(code.expiresIn))
                while Date() < deadline {
                    try await Task.sleep(for: .seconds(interval))
                    do {
                        let access = try await client.poll(deviceCode: code.deviceCode)
                        TVTokenStore.save(access)
                        token = access
                        pairing = nil
                        return
                    } catch TVAPIError.pending {
                    } catch TVAPIError.slowDown {
                        interval += 5
                    }
                }
            } catch {
                try? await Task.sleep(for: .seconds(5))
            }
            pairing = nil
        }
    }

    func refreshDashboard() async {
        guard let token else { return }
        do {
            let next: TVDashboard = try await client.get("/tv/api/dashboard", token: token)
            let wasRinging = (dashboard?.calls?.last24h.ringing ?? 0) > 0
            if !wasRinging && (next.calls?.last24h.ringing ?? 0) > 0 {
                AudioServicesPlaySystemSound(1005)
            }
            dashboard = next
            dashboardFailed = false
            lastUpdated = Date()
        } catch TVAPIError.unauthorized {
            signOut()
        } catch {
            dashboardFailed = true
        }
    }

    func activity(cursor: String?) async throws -> TVPage<TVActivityItem> {
        try await read("/tv/api/activity", cursor.map { [URLQueryItem(name: "cursor", value: $0)] } ?? [])
    }

    func documents(type: String?, cursor: String?) async throws -> TVPage<TVDocument> {
        var query: [URLQueryItem] = []
        if let type { query.append(URLQueryItem(name: "type", value: type)) }
        if let cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
        return try await read("/tv/api/documents", query)
    }

    func pdf(_ id: String) async throws -> Data {
        guard let token else { throw TVAPIError.unauthorized }
        do {
            return try await client.data("/tv/api/documents/\(id)/pdf", token: token)
        } catch TVAPIError.unauthorized {
            signOut()
            throw TVAPIError.unauthorized
        }
    }

    func signOut() {
        TVTokenStore.clear()
        token = nil
        dashboard = nil
        dashboardFailed = false
        lastUpdated = nil
    }

    private func read<T: Codable & Sendable>(_ path: String, _ query: [URLQueryItem]) async throws -> T {
        guard let token else { throw TVAPIError.unauthorized }
        do {
            return try await client.get(path, query: query, token: token)
        } catch TVAPIError.unauthorized {
            signOut()
            throw TVAPIError.unauthorized
        }
    }
}
