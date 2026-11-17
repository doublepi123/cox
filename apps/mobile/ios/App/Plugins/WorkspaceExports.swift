import OSLog
import UIKit
import WebKit

final class WorkspaceExports: NSObject, WKDownloadDelegate, UIDocumentPickerDelegate {
    weak var presenter: UIViewController?
    var profile: WorkspaceProfile?
    private var downloads: [ObjectIdentifier: WKDownload] = [:]
    private var destinations: [ObjectIdentifier: URL] = [:]
    private var directories: [URL] = []
    private let logger = Logger(subsystem: "dev.doublepi.cox.mobile", category: "downloads")

    func track(_ download: WKDownload) {
        downloads[ObjectIdentifier(download)] = download
        download.delegate = self
    }

    private func destination(_ filename: String) throws -> URL {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        directories.append(folder)
        return folder.appendingPathComponent(filename)
    }

    func save(_ data: Data, filename: String) {
        do {
            let url = try destination(filename)
            try data.write(to: url, options: [.atomic, .completeFileProtection])
            present(url)
        } catch {
            logger.error("workspace.export_failed")
        }
    }

    private func present(_ url: URL) {
        guard let presenter, presenter.presentedViewController == nil else {
            logger.warning("workspace.export_unavailable")
            return
        }
        let picker = UIDocumentPickerViewController(forExporting: [url], asCopy: true)
        picker.delegate = self
        presenter.present(picker, animated: true)
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        guard let url = response.url, profile?.matches(url) == true else {
            logger.warning("workspace.security_refusal reason=download_origin")
            completionHandler(nil)
            return
        }
        let name = (suggestedFilename as NSString).lastPathComponent
        do {
            let target = try destination(WorkspaceShellRequest.safeFilename(name) ? name : "download")
            destinations[ObjectIdentifier(download)] = target
            completionHandler(target)
        } catch {
            logger.error("workspace.download_destination_failed")
            completionHandler(nil)
        }
    }

    func download(_ download: WKDownload, willPerformHTTPRedirection response: HTTPURLResponse,
                  newRequest request: URLRequest,
                  decisionHandler: @escaping (WKDownload.RedirectPolicy) -> Void) {
        guard let url = request.url, profile?.matches(url) == true else {
            logger.warning("workspace.security_refusal reason=download_redirect")
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func downloadDidFinish(_ download: WKDownload) {
        let id = ObjectIdentifier(download)
        downloads.removeValue(forKey: id)
        if let url = destinations.removeValue(forKey: id) { present(url) }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        let id = ObjectIdentifier(download)
        downloads.removeValue(forKey: id)
        destinations.removeValue(forKey: id)
        logger.error("workspace.download_failed")
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { cleanExports() }
    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        cleanExports()
    }

    private func cleanExports() {
        let pending = Set(destinations.values.map { $0.deletingLastPathComponent() })
        for folder in directories where !pending.contains(folder) {
            do { try FileManager.default.removeItem(at: folder) }
            catch { logger.error("workspace.export_cleanup_failed") }
        }
        directories = directories.filter { pending.contains($0) }
    }

    func dispose() {
        for download in downloads.values {
            download.delegate = nil
            download.cancel { _ in }
        }
        downloads.removeAll()
        destinations.removeAll()
        cleanExports()
    }
}
