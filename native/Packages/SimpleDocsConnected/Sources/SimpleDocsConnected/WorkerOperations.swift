import Foundation

/// Describes the current owner Worker's draft and fax read contracts. This is not a transport,
/// authentication grant, or promise that a selected instance implements these routes.
public enum WorkerOperation: Sendable, Equatable {
    case readMailDraft(UUID)
    case saveMailDraft(UUID, revision: Int, content: Data)
    case readFax(UUID)
}

public enum WorkerPlanError: Error, Equatable, Sendable {
    case noActiveInstance
    case staleContext
    case invalidIdentifier
    case invalidDraft
    case draftTooLarge
}

/// A plan is inert: it cannot issue a request or carry credentials. The future transport must
/// recheck its binding immediately before sending and after receiving, enforce CredentialPolicy,
/// refuse redirects and disable shared cookies/cache. Planning does not verify identity or consent.
public struct WorkerPlan: Sendable, Equatable {
    public let binding: ContextBinding
    public let url: URL
    public let method: String
    public let contentType: String?
    public let body: Data?

    public func isCurrent(in registry: InstanceRegistry) -> Bool {
        guard registry.isCurrent(binding), let active = registry.active else { return false }
        return OriginBinding.permits(url, for: active.scope.origin)
    }
}

public enum WorkerPlanner {
    /// Builds only routes that actually exist in the owner Worker, not the proposed /api/v1 API.
    /// Voice and paid actions intentionally have no plan until their contracts are reviewed.
    public static func plan(_ operation: WorkerOperation, binding: ContextBinding, registry: InstanceRegistry) throws -> WorkerPlan {
        guard let active = registry.active else { throw WorkerPlanError.noActiveInstance }
        guard registry.isCurrent(binding) else { throw WorkerPlanError.staleContext }

        let id: UUID
        let route: String
        let method: String
        var body: Data?
        switch operation {
        case .readMailDraft(let value):
            (id, route, method) = (value, "mail-drafts", "GET")
        case .readFax(let value):
            (id, route, method) = (value, "faxes", "GET")
        case .saveMailDraft(let value, let revision, let content):
            (id, route, method) = (value, "mail-drafts", "PUT")
            guard content.count <= 65_536 else { throw WorkerPlanError.draftTooLarge }
            guard revision >= 0, revision <= 9_007_199_254_740_990,
                  let object = try? JSONSerialization.jsonObject(with: content), object is [String: Any]
            else { throw WorkerPlanError.invalidDraft }
            guard let encoded = try? JSONSerialization.data(withJSONObject: ["revision": revision, "content": object], options: [.sortedKeys]) else {
                throw WorkerPlanError.invalidDraft
            }
            guard encoded.count <= 65_536 else { throw WorkerPlanError.draftTooLarge }
            body = encoded
        }
        // Worker accepts RFC 4122 version 4 UUIDs, not arbitrary UUID strings.
        let raw = id.uuidString.lowercased()
        guard raw[raw.index(raw.startIndex, offsetBy: 14)] == "4",
              "89ab".contains(raw[raw.index(raw.startIndex, offsetBy: 19)])
        else { throw WorkerPlanError.invalidIdentifier }
        var components = URLComponents()
        components.scheme = "https"
        components.host = active.scope.origin.host
        components.port = active.scope.origin.port
        components.path = "/api/\(route)/\(raw)"
        guard let url = components.url, OriginBinding.permits(url, for: active.scope.origin) else {
            throw WorkerPlanError.staleContext
        }
        return WorkerPlan(binding: binding, url: url, method: method,
                          contentType: body == nil ? nil : "application/json", body: body)
    }
}

/// Provider acceptance is not delivery. Unknown future server statuses remain explicitly unknown.
public enum FaxReadStatus: Sendable, Equatable {
    case accepted, delivered, failed, unknown

    public init(serverValue: String) {
        switch serverValue {
        case "accepted": self = .accepted
        case "delivered": self = .delivered
        case "failed": self = .failed
        default: self = .unknown
        }
    }
}
