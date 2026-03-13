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
        case "undo-redo-state":
            if let canUndo = body["canUndo"] as? Bool,
                let canRedo = body["canRedo"] as? Bool
            {
                if let customWebView = webView as? CustomWebView {
                    customWebView.updateUndoRedoState(canUndo: canUndo, canRedo: canRedo)
                }
            }
        case "haptic":
            let style = body["style"] as? String ?? "light"
            triggerHaptic(style: style)
        case "editor-focus":
            if let focused = body["focused"] as? Bool {
                if let customWebView = webView as? CustomWebView {
                    customWebView.updateEditorFocus(focused: focused)
                }
            }
        case "open-photo-library":
            imagePickerCoordinator?.openPhotoLibrary()
        case "open-camera":
            imagePickerCoordinator?.openCamera()
        case "toolbar-icon":
            if let iconType = body["iconType"] as? String {
                if let customWebView = webView as? CustomWebView {
                    customWebView.updateToolbarIcon(iconType: iconType)
                }
            }
        case "open-url":
            if let urlString = body["url"] as? String,
                let url = URL(string: urlString)
            {
                DispatchQueue.main.async {
                    UIApplication.shared.open(url)
                }
            }
        case "formatting-state":
            if let isBold = body["bold"] as? Bool,
                let isItalic = body["italic"] as? Bool,
                let isCode = body["code"] as? Bool,
                let isStrikethrough = body["strikethrough"] as? Bool
            {
                if let customWebView = webView as? CustomWebView {
                    customWebView.updateFormattingState(
                        isBold: isBold,
                        isItalic: isItalic,
                        isCode: isCode,
                        isStrikethrough: isStrikethrough
                    )
                }
            }
        case "theme-change":
            if let theme = body["theme"] as? String {
                updateAppTheme(theme: theme)
            }
        case "setColorScheme":
            if let colorScheme = body["colorScheme"] as? String {
                updateAppColorScheme(colorScheme: colorScheme)
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

    private func updateAppTheme(theme: String) {
        DispatchQueue.main.async {
            if let windowScene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
               let window = windowScene.windows.first
            {
                switch theme {
                case "dark":
                    window.overrideUserInterfaceStyle = .dark
                case "light":
                    window.overrideUserInterfaceStyle = .light
                case "system":
                    window.overrideUserInterfaceStyle = .unspecified
                default:
                    window.overrideUserInterfaceStyle = .unspecified
                }
            }
        }
    }

    private func updateAppColorScheme(colorScheme: String) {
        DispatchQueue.main.async {
            if let windowScene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
               let window = windowScene.windows.first
            {
                switch colorScheme {
                case "dark":
                    window.overrideUserInterfaceStyle = .dark
                case "light":
                    window.overrideUserInterfaceStyle = .light
                default:
                    break
                }
            }
        }
    }
}
