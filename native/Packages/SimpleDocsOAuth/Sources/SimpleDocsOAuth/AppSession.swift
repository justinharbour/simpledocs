import Foundation
import SimpleDocsConnected

/// App-facing, in-memory lifecycle. A ready state means only that an OAuth token
/// was acquired; it does not establish that the Worker accepted the token.
@MainActor public final class AppSession {
    public enum State: Equatable, Sendable { case signedOut, signingIn, tokenAcquired, failed }
    public private(set) var state: State = .signedOut
    private let flow: ConnectedFlow
    private var generation: UInt64 = 0

    public init(flow: ConnectedFlow) { self.flow = flow }

    public func signIn(confirmation: IssuerConfirmation, binding: ContextBinding, callback: URL) async throws {
        generation &+= 1
        let current = generation
        state = .signingIn
        do {
            try await flow.signIn(confirmation: confirmation, binding: binding, callback: callback)
            guard generation == current, !Task.isCancelled else { throw CoordinatorError.staleContext }
            state = .tokenAcquired
        } catch {
            if generation == current { flow.clear(); state = .failed }
            throw error
        }
    }

    /// Clears local credentials only; this does not revoke the provider token.
    public func signOut() {
        generation &+= 1
        flow.clear()
        state = .signedOut
    }
}
