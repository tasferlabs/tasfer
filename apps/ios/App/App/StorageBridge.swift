import UIKit
import WebKit

class StorageBridge: NSObject, WKScriptMessageHandler {
    weak var webView: WKWebView?
    weak var presentingViewController: UIViewController?
    private let fileManager = FileManager.default

    private lazy var baseURL: URL = {
        let docs = fileManager.urls(for: .documentDirectory, in: .userDomainMask).first!
        let tasfer = docs.appendingPathComponent("tasfer", isDirectory: true)
        try? fileManager.createDirectory(
            at: tasfer, withIntermediateDirectories: true, attributes: nil)
        return tasfer
    }()

    /// `standardizedFileURL` collapses `..` textually; `resolvingSymlinksInPath`
    /// then collapses any link planted inside the sandbox. Applying both to each
    /// side is what makes the containment check below meaningful.
    private func canonical(_ url: URL) -> URL {
        return url.standardizedFileURL.resolvingSymlinksInPath()
    }

    /// Resolve `path` inside the storage sandbox, or nil when it escapes.
    ///
    /// `path` crosses the bridge from JavaScript, so a bare
    /// `baseURL.appendingPathComponent(path)` lets `../` segments reach anywhere
    /// in the app container — with `delete` removing directories recursively.
    /// Mirrors `AndroidBridge.resolveInStorage`.
    private func resolveInStorage(_ path: String) -> URL? {
        let base = canonical(baseURL)
        let target = canonical(base.appendingPathComponent(path))
        guard target == base || target.path.hasPrefix(base.path + "/") else { return nil }
        return target
    }

    /// Resolve `fileName` to a file directly inside the temp dir used to stage
    /// share-sheet payloads, or nil when it escapes. Same rule as
    /// `resolveInStorage`, tightened to one flat directory since share names are
    /// never nested.
    private func resolveShareFile(_ fileName: String) -> URL? {
        let base = canonical(fileManager.temporaryDirectory)
        let target = canonical(base.appendingPathComponent(fileName))
        guard target.deletingLastPathComponent().path == base.path else { return nil }
        return target
    }

    func userContentController(
        _ userContentController: WKUserContentController, didReceive message: WKScriptMessage
    ) {
        guard let body = message.body as? [String: Any],
            let action = body["action"] as? String,
            let callbackId = body["callbackId"] as? String
        else {
            return
        }

        var result: Any = NSNull()
        var errorMsg: String? = nil

        switch action {
        case "paste":
            let clipboardText = UIPasteboard.general.string ?? ""
            result = clipboardText
            sendCallback(callbackId: callbackId, result: result, error: nil)
            return

        case "shareFile":
            if let dataStr = body["data"] as? String,
               let fileName = body["fileName"] as? String,
               let bytes = Data(base64Encoded: dataStr)
            {
                guard let tempFile = resolveShareFile(fileName) else {
                    sendCallback(callbackId: callbackId, result: nil, error: "Invalid fileName")
                    return
                }
                do {
                    try bytes.write(to: tempFile)
                } catch {
                    sendCallback(callbackId: callbackId, result: nil, error: error.localizedDescription)
                    return
                }

                // Present share sheet on main thread (async — sends callback when done)
                DispatchQueue.main.async { [weak self] in
                    guard let vc = self?.presentingViewController else {
                        self?.sendCallback(callbackId: callbackId, result: nil, error: "No presenting view controller")
                        return
                    }
                    let activityVC = UIActivityViewController(activityItems: [tempFile], applicationActivities: nil)
                    activityVC.completionWithItemsHandler = { _, completed, _, _ in
                        // Clean up temp file
                        try? FileManager.default.removeItem(at: tempFile)
                        self?.sendCallback(callbackId: callbackId, result: completed, error: nil)
                    }
                    // iPad requires popover source
                    if let popover = activityVC.popoverPresentationController {
                        popover.sourceView = vc.view
                        popover.sourceRect = CGRect(x: vc.view.bounds.midX, y: vc.view.bounds.midY, width: 0, height: 0)
                        popover.permittedArrowDirections = []
                    }
                    vc.present(activityVC, animated: true)
                }
                return // callback sent asynchronously
            } else {
                errorMsg = "Invalid data or fileName"
            }
            
        case "htmlToPdf":
            if let html = body["html"] as? String {
                if #available(iOS 14.0, *) {
                    let renderer = PdfRenderer { [weak self] data, err in
                        if let data = data {
                            self?.sendCallback(callbackId: callbackId, result: data.base64EncodedString(), error: nil)
                        } else {
                            self?.sendCallback(callbackId: callbackId, result: nil, error: err ?? "PDF render failed")
                        }
                    }
                    renderer.render(html: html)
                    return // async
                } else {
                 }
            } else {
                errorMsg = "Invalid html"
            }

        case "write":
            if let path = body["path"] as? String,
                let dataStr = body["data"] as? String,
                let bytes = Data(base64Encoded: dataStr)
            {
                guard let url = resolveInStorage(path) else {
                    errorMsg = "Invalid path"
                    break
                }
                do {
                    try fileManager.createDirectory(
                        at: url.deletingLastPathComponent(),
                        withIntermediateDirectories: true,
                        attributes: nil
                    )
                    try bytes.write(to: url)
                    result = true
                } catch {
                    errorMsg = error.localizedDescription
                }
            } else {
                errorMsg = "Invalid path or data"
            }

        case "read":
            if let path = body["path"] as? String {
                guard let url = resolveInStorage(path) else {
                    errorMsg = "Invalid path"
                    break
                }
                if let data = fileManager.contents(atPath: url.path) {
                    result = data.base64EncodedString()
                } else {
                    errorMsg = "File not found"
                }
            } else {
                errorMsg = "Invalid path"
            }

        case "delete":
            if let path = body["path"] as? String {
                guard let url = resolveInStorage(path) else {
                    errorMsg = "Invalid path"
                    break
                }
                do {
                    if fileManager.fileExists(atPath: url.path) {
                        try fileManager.removeItem(at: url)
                    }
                    result = true
                } catch {
                    errorMsg = error.localizedDescription
                }
            } else {
                errorMsg = "Invalid path"
            }

        case "list":
            if let path = body["path"] as? String {
                guard let url = resolveInStorage(path) else {
                    result = [String]()
                    break
                }
                do {
                    if fileManager.fileExists(atPath: url.path) {
                        let files = try fileManager.contentsOfDirectory(atPath: url.path)
                        result = files
                    } else {
                        result = [String]()
                    }
                } catch {
                    result = [String]()
                }
            } else {
                errorMsg = "Invalid path"
            }

        case "exists":
            if let path = body["path"] as? String {
                guard let url = resolveInStorage(path) else {
                    result = false
                    break
                }
                result = fileManager.fileExists(atPath: url.path)
            } else {
                errorMsg = "Invalid path"
            }

        case "getStorageInfo":
            do {
                let attrs = try fileManager.attributesOfFileSystem(forPath: baseURL.path)
                let free = (attrs[.systemFreeSize] as? Int64) ?? 0
                let total = (attrs[.systemSize] as? Int64) ?? 0
                result = ["free": free, "total": total]
            } catch {
                errorMsg = error.localizedDescription
            }

        default:
            errorMsg = "Unknown action: \(action)"
        }

        // Send response back to JavaScript
        sendCallback(callbackId: callbackId, result: result, error: errorMsg)
    }

    private func sendCallback(callbackId: String, result: Any?, error: String?) {
        var response: [String: Any]
        if let error = error {
            response = ["error": error]
        } else {
            response = ["result": result ?? NSNull()]
        }

        if let jsonData = try? JSONSerialization.data(withJSONObject: response),
            let jsonStr = String(data: jsonData, encoding: .utf8)
        {
            let javascript = "window.__nativeStorageCallbacks?.get?.('\(callbackId)')?.(\(jsonStr))"
            DispatchQueue.main.async {
                self.webView?.evaluateJavaScript(javascript, completionHandler: nil)
            }
        }
    }
}
