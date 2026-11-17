import Foundation

/// What the app knows about trust in a linked instance. There is no verified case: discovery,
/// issuer and audience binding are undecided, so an address the person typed stays "user entered".
public enum InstanceTrust: Sendable, Equatable {
    case userEnteredUnverified
}

public struct LinkedInstance: Sendable, Equatable {
    public let scope: SessionScope
    public let trust: InstanceTrust

    public var linkID: InstanceLinkID { scope.linkID }
    public var origin: InstanceOrigin { scope.origin }
}

/// Snapshot of the selected instance. `epoch` increases on every switch or unlink, so work started
/// under an earlier selection can be detected and refused.
public struct ActiveContext: Sendable, Equatable {
    public let scope: SessionScope
    public let epoch: UInt64
}

/// Pins a pending action (a draft, a submit, a download) to the link and selection it began under.
public struct ContextBinding: Sendable, Equatable {
    public let linkID: InstanceLinkID
    public let epoch: UInt64

    public init(_ context: ActiveContext) {
        linkID = context.scope.linkID
        epoch = context.epoch
    }
}

public enum PurgeItem: Sendable, Equatable, CaseIterable {
    case sessionMaterial
    case cachedRecords
    case idempotencyKeys
    case pendingActions
}

public enum ServerRevocation: Sendable, Equatable {
    /// Unlinking removes local state only. It does not prove the server ended the session.
    case notAttempted
}

public struct UnlinkReceipt: Sendable, Equatable {
    public let scope: SessionScope
    public let purge: [PurgeItem]
    public let serverRevocation: ServerRevocation
}

public enum LinkError: Error, Equatable, Sendable {
    case alreadyLinked
    case linkIDReused
    case notLinked
}

/// In-memory model of linked instances and the explicit selection between them. It stores no
/// credential, makes no request and persists nothing. A later change owns persistence.
public struct InstanceRegistry: Sendable, Equatable {
    public private(set) var instances: [InstanceLinkID: LinkedInstance] = [:]
    public private(set) var activeLinkID: InstanceLinkID?
    public private(set) var epoch: UInt64 = 0
    /// Every ID ever issued by this registry, including unlinked ones. IDs are never reused.
    private var issuedLinkIDs: Set<InstanceLinkID> = []

    public init() {}

    public var active: ActiveContext? {
        guard let id = activeLinkID, let instance = instances[id] else { return nil }
        return ActiveContext(scope: instance.scope, epoch: epoch)
    }

    /// Links an origin under a freshly generated ID. Linking never selects it, never changes the
    /// active instance or epoch, and never copies state from another link.
    @discardableResult
    public mutating func link(_ acknowledged: AcknowledgedOrigin) throws -> LinkedInstance {
        var id = InstanceLinkID()
        while issuedLinkIDs.contains(id) { id = InstanceLinkID() }
        return try link(acknowledged, id: id)
    }

    /// Deterministic injection for tests only (not public). An ID that is currently linked, or was
    /// ever issued and since unlinked, is refused before any state changes.
    @discardableResult
    mutating func link(_ acknowledged: AcknowledgedOrigin, id: InstanceLinkID) throws -> LinkedInstance {
        guard !issuedLinkIDs.contains(id) else { throw LinkError.linkIDReused }
        guard !instances.values.contains(where: { $0.origin == acknowledged.origin }) else {
            throw LinkError.alreadyLinked
        }
        let instance = LinkedInstance(scope: SessionScope(linkID: id, origin: acknowledged.origin), trust: .userEnteredUnverified)
        issuedLinkIDs.insert(id)
        instances[id] = instance
        return instance
    }

    /// Selecting is explicit. Every change of selection starts a new epoch.
    @discardableResult
    public mutating func activate(_ id: InstanceLinkID) throws -> ActiveContext {
        guard let instance = instances[id] else { throw LinkError.notLinked }
        if activeLinkID != id {
            activeLinkID = id
            epoch += 1
        }
        return ActiveContext(scope: instance.scope, epoch: epoch)
    }

    public mutating func unlink(_ id: InstanceLinkID) throws -> UnlinkReceipt {
        guard let instance = instances.removeValue(forKey: id) else { throw LinkError.notLinked }
        if activeLinkID == id {
            activeLinkID = nil
            epoch += 1
        }
        return UnlinkReceipt(scope: instance.scope, purge: PurgeItem.allCases, serverRevocation: .notAttempted)
    }

    /// A binding is current only while its link exists and is still the selected one in the same epoch.
    public func isCurrent(_ binding: ContextBinding) -> Bool {
        activeLinkID == binding.linkID && instances[binding.linkID] != nil && epoch == binding.epoch
    }
}
