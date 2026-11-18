// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "SimpleDocsDirect",
    platforms: [.macOS(.v14), .iOS(.v17)],
    products: [.library(name: "SimpleDocsDirect", targets: ["SimpleDocsDirect"])],
    targets: [
        .target(name: "SimpleDocsDirect"),
        .testTarget(name: "SimpleDocsDirectTests", dependencies: ["SimpleDocsDirect"]),
    ]
)
