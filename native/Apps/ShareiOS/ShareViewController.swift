import UIKit
import UniformTypeIdentifiers

/// Queues one PDF for explicit review in the containing app. Never sends it.
final class ShareViewController: UIViewController {
    private let status = UILabel()
    private var button: UIButton!
    private let group = "group.com.justinharbour.simpledocs"
    private let limit = 20 * 1024 * 1024

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        status.text = "Save a PDF to review in simpledocs. Nothing will be sent."
        status.numberOfLines = 0
        button = UIButton(type: .system)
        button.setTitle("Save for review", for: .normal)
        button.addTarget(self, action: #selector(save), for: .touchUpInside)
        let cancel = UIButton(type: .system)
        cancel.setTitle("Cancel", for: .normal)
        cancel.addTarget(self, action: #selector(close), for: .touchUpInside)
        let stack = UIStackView(arrangedSubviews: [status, button, cancel])
        stack.axis = .vertical; stack.spacing = 20; stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 24), stack.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -24), stack.centerYAnchor.constraint(equalTo: view.centerYAnchor)])
    }

    @objc private func close() { extensionContext?.cancelRequest(withError: NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError)) }

    @objc private func save() {
        let items = extensionContext?.inputItems as? [NSExtensionItem] ?? []
        let providers = items.flatMap { $0.attachments ?? [] }.filter { $0.hasItemConformingToTypeIdentifier(UTType.pdf.identifier) }
        guard providers.count == 1 else { status.text = "Share one PDF at a time."; return }
        button.isEnabled = false
        providers[0].loadFileRepresentation(forTypeIdentifier: UTType.pdf.identifier) { [weak self] url, _ in
            guard let self else { return }
            var saved = false
            if let url, let groupURL = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: self.group),
               let handle = try? FileHandle(forReadingFrom: url) {
                defer { try? handle.close() }
                if let data = try? handle.read(upToCount: self.limit + 1), !data.isEmpty, data.count <= self.limit, data.starts(with: Data("%PDF-".utf8)) {
                    let directory = groupURL.appendingPathComponent("ShareInbox", isDirectory: true)
                    do {
                        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.complete])
                        let existing = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles])
                        guard existing.count < 10 else { throw NSError(domain: "simpledocs.share", code: 1) }
                        let destination = directory.appendingPathComponent(UUID().uuidString + ".pdf")
                        try data.write(to: destination, options: [.atomic, .completeFileProtection])
                        saved = true
                    } catch { saved = false }
                }
            }
            DispatchQueue.main.async {
                if saved { self.extensionContext?.completeRequest(returningItems: nil) }
                else { self.status.text = "Could not save this PDF. Use a PDF under 20 MB, or remove shared PDFs in simpledocs and try again."; self.button.isEnabled = true }
            }
        }
    }
}
