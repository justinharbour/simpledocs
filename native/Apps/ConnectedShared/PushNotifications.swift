import Foundation
import SimpleDocsConnected
import UserNotifications

#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// Asks for notification permission after sign-in, registers with APNs and hands the
/// device token to the signed-in session. Tokens are never logged or stored.
@MainActor final class PushCoordinator {
    static let shared = PushCoordinator()

    #if os(macOS)
    static let platform = PushPlatform.macos
    #else
    static let platform = PushPlatform.ios
    #endif
    #if DEBUG
    static let environment = PushEnvironment.sandbox
    #else
    static let environment = PushEnvironment.production
    #endif

    private var send: (@MainActor (String) async -> Void)?
    var report: (@MainActor (String) -> Void)?
    var onOpen: (@MainActor () -> Void)?

    func start(send: @escaping @MainActor (String) async -> Void) async {
        self.send = send
        guard let permission = try? await SystemPushPermission().request(), permission == .authorized else { return }
        #if os(macOS)
        NSApplication.shared.registerForRemoteNotifications()
        #else
        UIApplication.shared.registerForRemoteNotifications()
        #endif
    }

    func stop() { send = nil }

    func didRegister(_ deviceToken: Data) {
        guard let send else { return }
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        Task { await send(token) }
    }

    func didFail() { report?("Push registration failed.") }
}

private let foregroundPresentation: UNNotificationPresentationOptions = [.banner, .list, .sound]

#if os(macOS)
final class PushAppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        UNUserNotificationCenter.current().delegate = self
    }
    func application(_ application: NSApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        PushCoordinator.shared.didRegister(deviceToken)
    }
    func application(_ application: NSApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        PushCoordinator.shared.didFail()
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        foregroundPresentation
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        await MainActor.run { PushCoordinator.shared.onOpen?() }
    }
}
#else
final class PushAppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        PushCoordinator.shared.didRegister(deviceToken)
    }
    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        PushCoordinator.shared.didFail()
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        foregroundPresentation
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        await MainActor.run { PushCoordinator.shared.onOpen?() }
    }
}
#endif
