import UIKit
import WebKit

class ClipboardBridge: NSObject, WKScriptMessageHandler {
    weak var webView: WKWebView?
    weak var imagePickerCoordinator: ImagePickerCoordinator?

    func userContentController(
        _ userContentController: WKUserContentController, didReceive message: WKScriptMessage
    ) {
        guard let body = message.body as? [String: Any],
            let action = body["action"] as? String
        else {
            return
        }

        switch action {
        case "copy":
            if let text = body["text"] as? String {
                UIPasteboard.general.string = text
            }
        case "cut":
            if let text = body["text"] as? String {
                UIPasteboard.general.string = text
            }
        case "paste":
            let clipboardText = UIPasteboard.general.string ?? ""
            let javascript = """
                window.postMessage({ type: 'clipboard-paste', text: '\(clipboardText.replacingOccurrences(of: "'", with: "\\'").replacingOccurrences(of: "\n", with: "\\n"))' }, '*');
                """
            webView?.evaluateJavaScript(javascript, completionHandler: nil)
        case "haptic":
            let style = body["style"] as? String ?? "light"
            triggerHaptic(style: style)
        case "open-photo-library":
            imagePickerCoordinator?.openPhotoLibrary()
        case "open-camera":
            imagePickerCoordinator?.openCamera()
        case "open-url":
            if let urlString = body["url"] as? String,
                let url = URL(string: urlString)
            {
                DispatchQueue.main.async {
                    UIApplication.shared.open(url)
                }
            }
        case "setColorScheme":
            // Keyed off the user's theme *setting*, not the scheme it resolved
            // to: pinning the window in system mode would freeze the WebView's
            // trait collection and the app would stop following the OS.
            if let source = body["source"] as? String {
                updateInterfaceStyle(source: source)
            }
        default:
            break
        }
    }

    private func triggerHaptic(style: String) {
        let generator: UIImpactFeedbackGenerator
        switch style {
        case "light":
            generator = UIImpactFeedbackGenerator(style: .light)
        case "medium":
            generator = UIImpactFeedbackGenerator(style: .medium)
        case "heavy":
            generator = UIImpactFeedbackGenerator(style: .heavy)
        default:
            generator = UIImpactFeedbackGenerator(style: .light)
        }
        generator.prepare()
        generator.impactOccurred()
    }

    /**
     Mirror the in-app theme setting onto the window, so UIKit-drawn chrome —
     the keyboard, context menus, selection UI — follows it. `.unspecified`
     hands the window back to the OS setting.
     */
    private func updateInterfaceStyle(source: String) {
        DispatchQueue.main.async {
            if let windowScene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
               let window = windowScene.windows.first
            {
                switch source {
                case "dark":
                    window.overrideUserInterfaceStyle = .dark
                case "light":
                    window.overrideUserInterfaceStyle = .light
                default:
                    window.overrideUserInterfaceStyle = .unspecified
                }
            }
        }
    }
}
