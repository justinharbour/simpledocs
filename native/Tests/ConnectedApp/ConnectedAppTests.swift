import SimpleDocsConnected
import SimpleDocsOAuth
import XCTest
@testable import simpledocs

@MainActor final class ConnectedAppTests: XCTestCase {
    func testNavigationActionsBumpTicksAndSelectSend() {
        let actions = AppActions()
        actions.area = .records
        let before = actions.newSendTick
        actions.newSend()
        XCTAssertEqual(actions.area, .send)
        XCTAssertEqual(actions.newSendTick, before + 1)
        actions.refresh()
        XCTAssertEqual(actions.refreshTick, 1)
    }

    func testSignedOutModelStartsWithTheDefaultInstanceAndNoSession() {
        let defaults = UserDefaults(suiteName: "simpledocs.apptests." + UUID().uuidString)!
        let model = ConnectedModel(vault: MemoryVault(), defaults: defaults, anchor: AppAnchor())
        XCTAssertEqual(model.state, .signedOut)
        XCTAssertEqual(model.instance, ConnectedModel.defaultInstance)
        XCTAssertNil(model.api)
    }

    func testAreasHaveTitlesAndSymbols() {
        XCTAssertEqual(Area.allCases.map(\.title), ["Send", "Records", "Calls", "Settings"])
        XCTAssertTrue(Area.allCases.allSatisfy { !$0.symbol.isEmpty })
    }
}
