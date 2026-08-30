import SwiftUI
import Combine
import Foundation
import ImageCaptureCore

private let targetVendorID: Int32 = 0x1949
private let targetProductID: Int32 = 0x9981

struct FoundDevice: Identifiable, Sendable {
    let id: ObjectIdentifier
    let name: String
    let transport: String
    let vendorID: Int32
    let productID: Int32

    var matchesKindle: Bool {
        vendorID == targetVendorID && productID == targetProductID
    }

    var vendorHex: String {
        String(format: "0x%04X", UInt32(bitPattern: vendorID))
    }

    var productHex: String {
        String(format: "0x%04X", UInt32(bitPattern: productID))
    }
}

@MainActor
final class KindleDeviceProbe: NSObject,
                               ObservableObject,
                               ICDeviceBrowserDelegate {
    @Published private(set) var devices: [FoundDevice] = []
    @Published private(set) var log = [
        "Connect the Kindle, then tap Start Scan."
    ]
    @Published private(set) var hasSeenTarget = false
    @Published private(set) var authorizationText = "Checking…"

    private let browser = ICDeviceBrowser()
    private var scanGeneration = 0

    override init() {
        super.init()
        browser.delegate = self

        let rawMask = ICDeviceTypeMask.camera.rawValue |
            ICDeviceLocationTypeMask.local.rawValue
        browser.browsedDeviceTypeMask = ICDeviceTypeMask(rawValue: rawMask)!
    }

    func start() {
        Task {
            await requestAuthorizationAndStart()
        }
    }

    private func requestAuthorizationAndStart() async {
        let status = browser.contentsAuthorizationStatus
        authorizationText = status.rawValue
        appendLog("Media authorization: \(status.rawValue)")

        switch status {
        case .authorized:
            beginBrowsing()
        case .denied:
            appendLog("Media access was denied. Enable Camera access in Settings.")
        case .restricted:
            appendLog("Media access is restricted on this iPhone.")
        default:
            appendLog("Requesting read-only media access…")
            let newStatus = await browser.requestContentsAuthorization()
            authorizationText = newStatus.rawValue
            appendLog("Authorization result: \(newStatus.rawValue)")

            if newStatus == .authorized {
                beginBrowsing()
            }
        }
    }

    private func beginBrowsing() {
        guard !browser.isBrowsing else {
            appendLog("Already scanning. Reconnect the Kindle if needed.")
            return
        }
        devices.removeAll()
        appendLog("Scanning for local ImageCaptureCore devices…")
        browser.start()

        scanGeneration += 1
        let generation = scanGeneration
        Task {
            try? await Task.sleep(for: .seconds(10))
            guard generation == scanGeneration, browser.isBrowsing else { return }

            let count = browser.devices?.count ?? 0
            appendLog("10-second check: browser reports \(count) device(s).")
        }
    }

    func restart() {
        if browser.isBrowsing {
            browser.stop()
        }
        devices.removeAll()
        appendLog("Restarting scan…")
        start()
    }

    func stop() {
        guard browser.isBrowsing else { return }
        scanGeneration += 1
        browser.stop()
        appendLog("Scan stopped.")
    }

    private func appendLog(_ message: String) {
        log.append(message)
        print("KINDLE_PROBE: \(message)")
    }

    private func added(_ device: FoundDevice) {
        devices.removeAll { $0.id == device.id }
        devices.append(device)

        if device.matchesKindle {
            hasSeenTarget = true
            appendLog(
                "TARGET MATCH: \(device.name), " +
                "VID \(device.vendorHex), PID \(device.productHex)"
            )
        } else {
            appendLog(
                "Other device: \(device.name), " +
                "VID \(device.vendorHex), PID \(device.productHex)"
            )
        }
    }

    private func removed(id: ObjectIdentifier, name: String) {
        devices.removeAll { $0.id == id }
        appendLog("Removed: \(name)")
    }

    nonisolated func deviceBrowser(
        _ browser: ICDeviceBrowser,
        didAdd device: ICDevice,
        moreComing: Bool
    ) {
        // Copy descriptive values only. Never open a session or access files.
        let found = FoundDevice(
            id: ObjectIdentifier(device),
            name: device.name ?? "Unnamed device",
            transport: device.transportType ?? "Unknown transport",
            vendorID: device.usbVendorID,
            productID: device.usbProductID
        )

        Task { @MainActor [weak self] in
            self?.added(found)
        }
    }

    nonisolated func deviceBrowser(
        _ browser: ICDeviceBrowser,
        didRemove device: ICDevice,
        moreGoing: Bool
    ) {
        let id = ObjectIdentifier(device)
        let name = device.name ?? "Unnamed device"

        Task { @MainActor [weak self] in
            self?.removed(id: id, name: name)
        }
    }

}

struct ContentView: View {
    @StateObject private var probe = KindleDeviceProbe()

    var body: some View {
        NavigationStack {
            List {
                Section("Result") {
                    if probe.hasSeenTarget {
                        Label(
                            "Kindle 0x1949 / 0x9981 detected",
                            systemImage: "checkmark.circle.fill"
                        )
                        .foregroundStyle(.green)
                    } else {
                        Label(
                            "Target Kindle not detected yet",
                            systemImage: "magnifyingglass"
                        )
                    }

                    Text("This probe is read-only. It never opens storage or changes files.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)

                    LabeledContent("Media access", value: probe.authorizationText)
                        .font(.footnote)
                }

                Section("Currently discovered") {
                    if probe.devices.isEmpty {
                        Text("No devices reported")
                            .foregroundStyle(.secondary)
                    }

                    ForEach(probe.devices) { device in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(device.name)
                                .font(.headline)
                            Text("\(device.vendorHex) / \(device.productHex)")
                                .font(.system(.body, design: .monospaced))
                            Text(device.transport)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }

                Section("Log") {
                    ForEach(Array(probe.log.enumerated()), id: \.offset) { _, line in
                        Text(line)
                            .font(.caption.monospaced())
                    }
                }
            }
            .navigationTitle("Kindle USB Probe")
            .toolbar {
                Button("Start Scan") {
                    probe.restart()
                }
            }
        }
        .task {
            probe.start()
        }
        .onDisappear {
            probe.stop()
        }
    }
}
