import AppKit
import UniformTypeIdentifiers

final class ShareViewController: NSViewController {
    private let status = NSTextField(wrappingLabelWithString: "Save a PDF to review in simpledocs. Nothing will be sent.")
    private var saveButton: NSButton!

    override func loadView() {
        view = NSView(frame: NSRect(x: 0, y: 0, width: 440, height: 180))
        saveButton = NSButton(title: "Save for review", target: self, action: #selector(save))
        let cancel = NSButton(title: "Cancel", target: self, action: #selector(close))
        let stack = NSStackView(views: [status, saveButton, cancel])
        stack.orientation = .vertical; stack.spacing = 16; stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24), stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24), stack.centerYAnchor.constraint(equalTo: view.centerYAnchor)])
    }

    @objc private func close() { extensionContext?.cancelRequest(withError: NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError)) }

    @objc private func save() {
        let items = extensionContext?.inputItems as? [NSExtensionItem] ?? []
        let providers = items.flatMap { $0.attachments ?? [] }.filter { $0.hasItemConformingToTypeIdentifier(UTType.pdf.identifier) }
        guard providers.count == 1 else { status.stringValue = "Share one PDF at a time."; return }
        saveButton.isEnabled = false
        providers[0].loadFileRepresentation(forTypeIdentifier: UTType.pdf.identifier) { [weak self] url, _ in
            var saved = false
            if let url, let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: "group.com.justinharbour.simpledocs"), let handle = try? FileHandle(forReadingFrom: url) {
                defer { try? handle.close() }
                if let data = try? handle.read(upToCount: 20 * 1024 * 1024 + 1), !data.isEmpty, data.count <= 20 * 1024 * 1024, data.starts(with: Data("%PDF-".utf8)) {
                    let directory = root.appendingPathComponent("ShareInbox", isDirectory: true)
                    do {
                        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
                        guard try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles]).count < 10 else { throw CocoaError(.fileWriteOutOfSpace) }
                        let dest = directory.appendingPathComponent(UUID().uuidString + ".pdf")
                        try data.write(to: dest, options: .atomic)
                        saved = true
                    } catch { saved = false }
                }
            }
            DispatchQueue.main.async {
                guard let self else { return }
                if saved { self.extensionContext?.completeRequest(returningItems: nil) }
                else { self.status.stringValue = "Could not save this PDF. Use a PDF under 20 MB, or remove shared PDFs and try again."; self.saveButton.isEnabled = true }
            }
        }
    }
}
