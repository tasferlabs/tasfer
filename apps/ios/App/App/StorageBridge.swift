import UIKit
import WebKit

class StorageBridge: NSObject, WKScriptMessageHandler {
    weak var webView: WKWebView?
    weak var presentingViewController: UIViewController?
    private let fileManager = FileManager.default

    private lazy var baseURL: URL = {
        let docs = fileManager.urls(for: .documentDirectory, in: .userDomainMask).first!
        let cypher = docs.appendingPathComponent("cypher", isDirectory: true)
        try? fileManager.createDirectory(
            at: cypher, withIntermediateDirectories: true, attributes: nil)
        return cypher
    }()

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
        case "shareFile":
            if let dataStr = body["data"] as? String,
               let fileName = body["fileName"] as? String,
               let bytes = Data(base64Encoded: dataStr)
            {
                // Write to temp file
                let tempDir = FileManager.default.temporaryDirectory
                let tempFile = tempDir.appendingPathComponent(fileName)
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

        case "write":
            if let path = body["path"] as? String,
                let dataStr = body["data"] as? String,
                let bytes = Data(base64Encoded: dataStr)
            {
                do {
                    let url = baseURL.appendingPathComponent(path)
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
                let url = baseURL.appendingPathComponent(path)
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
                let url = baseURL.appendingPathComponent(path)
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
                let url = baseURL.appendingPathComponent(path)
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
                let url = baseURL.appendingPathComponent(path)
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
