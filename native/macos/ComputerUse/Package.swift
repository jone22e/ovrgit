// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "ComputerUse",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "ovseer-computer", targets: ["ovseer-computer"])],
    targets: [.executableTarget(name: "ovseer-computer")]
)
