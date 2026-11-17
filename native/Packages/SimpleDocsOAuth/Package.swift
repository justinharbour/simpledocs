// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "SimpleDocsOAuth",
    platforms: [.macOS(.v14), .iOS(.v17)],
    products: [.library(name: "SimpleDocsOAuth", targets: ["SimpleDocsOAuth"])],
    dependencies: [.package(path: "../SimpleDocsConnected")],
    targets: [
        .target(name: "SimpleDocsOAuth", dependencies: [.product(name: "SimpleDocsConnected", package: "SimpleDocsConnected")]),
        .testTarget(name: "SimpleDocsOAuthTests", dependencies: ["SimpleDocsOAuth", .product(name: "SimpleDocsConnected", package: "SimpleDocsConnected")]),
    ]
)
