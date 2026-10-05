// swift-tools-version: 5.9
import PackageDescription

// Ajudante nativo do Ovseer: transcreve um arquivo de áudio em texto, neste Mac.
let package = Package(
    name: "Transcribe",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "ovseer-transcribe", targets: ["ovseer-transcribe"]),
    ],
    targets: [
        .executableTarget(name: "ovseer-transcribe"),
    ]
)
