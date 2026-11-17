// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "SimpleDocsKit",
    platforms: [
        .macOS(.v14),
        .iOS(.v17),
    ],
    products: [
        .library(name: "SimpleDocsCore", targets: ["SimpleDocsCore"]),
        .library(name: "SimpleDocsViews", targets: ["SimpleDocsViews"]),
    ],
    targets: [
        .target(name: "SimpleDocsCore"),
        .target(name: "SimpleDocsViews", dependencies: ["SimpleDocsCore"]),
        .testTarget(name: "SimpleDocsCoreTests", dependencies: ["SimpleDocsCore"]),
        .testTarget(name: "SimpleDocsViewsTests", dependencies: ["SimpleDocsViews", "SimpleDocsCore"]),
    ]
)
