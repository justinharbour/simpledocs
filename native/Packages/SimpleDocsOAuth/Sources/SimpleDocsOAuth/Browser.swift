import AuthenticationServices
import Foundation

public enum BrowserError: Error { case alreadyRunning, failedToStart, missingCallback }

/// The owner must retain this object and provide a presentation anchor. Cancellation is explicit.
@MainActor public final class OAuthBrowser: NSObject {
    private var session: ASWebAuthenticationSession?
    private var continuation: CheckedContinuation<URL, Error>?
    private var sessionID: UUID?
    private let anchorProvider: ASWebAuthenticationPresentationContextProviding

    public init(anchorProvider: ASWebAuthenticationPresentationContextProviding) {
        self.anchorProvider = anchorProvider
    }

    public func authorize(url: URL, callbackScheme: String) async throws -> URL {
        guard session == nil else { throw BrowserError.alreadyRunning }
        let id = UUID()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                guard !Task.isCancelled else { continuation.resume(throwing: CancellationError()); return }
                self.continuation = continuation
                self.sessionID = id
                let session = ASWebAuthenticationSession(url: url, callbackURLScheme: callbackScheme) { [weak self] url, error in
                    Task { @MainActor in
                        guard let self, self.sessionID == id, let pending = self.continuation else { return }
                        self.continuation = nil
                        self.session = nil
                        self.sessionID = nil
                        if let error { pending.resume(throwing: error) }
                        else if let url { pending.resume(returning: url) }
                        else { pending.resume(throwing: BrowserError.missingCallback) }
                    }
                }
                session.presentationContextProvider = anchorProvider
                session.prefersEphemeralWebBrowserSession = true
                self.session = session
                if !session.start() {
                    self.session = nil
                    self.continuation = nil
                    self.sessionID = nil
                    continuation.resume(throwing: BrowserError.failedToStart)
                }
            }
        } onCancel: {
            Task { @MainActor in
                if self.sessionID == id { self.cancel() }
            }
        }
    }

    public func cancel() {
        session?.cancel()
        session = nil
        sessionID = nil
        let pending = continuation
        continuation = nil
        pending?.resume(throwing: CancellationError())
    }
}
