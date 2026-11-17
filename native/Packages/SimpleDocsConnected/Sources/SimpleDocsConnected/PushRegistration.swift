import Foundation
import UserNotifications

public enum PushPermission: Sendable, Equatable {
    case authorized, denied, unavailable
}

/// Requests permission only after an explicit user action. Permission does not
/// imply registration with APNs or delivery of any notification.
@MainActor public protocol PushPermissionRequesting {
    func request() async throws -> PushPermission
}

@MainActor public struct SystemPushPermission: PushPermissionRequesting {
    public init() {}
    public func request() async throws -> PushPermission {
        let granted = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
        return granted ? .authorized : .denied
    }
}

public enum PushRegistrationError: Error, Equatable {
    case staleContext, invalidToken
}

/// Ephemeral APNs token scoped to the selected instance. Never log, persist,
/// or send it until a separate authenticated registration path is implemented.
public struct PendingPushToken: Sendable {
    private let bytes: Data
    private let binding: ContextBinding

    public init(_ bytes: Data, binding: ContextBinding, registry: InstanceRegistry) throws {
        guard registry.isCurrent(binding) else { throw PushRegistrationError.staleContext }
        guard !bytes.isEmpty, bytes.count <= 256 else { throw PushRegistrationError.invalidToken }
        self.bytes = bytes
        self.binding = binding
    }

    public func token(registry: InstanceRegistry) throws -> Data {
        guard registry.isCurrent(binding) else { throw PushRegistrationError.staleContext }
        return bytes
    }
}
