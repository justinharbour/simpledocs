// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "SimpleDocsConnected",
    platforms: [
        .macOS(.v14),
        .iOS(.v17),
    ],
    products: [
        .library(name: "SimpleDocsConnected", targets: ["SimpleDocsConnected"]),
    ],
    targets: [
        .target(name: "SimpleDocsConnected"),
        .testTarget(name: "SimpleDocsConnectedTests", dependencies: ["SimpleDocsConnected"]),
    ]
)
