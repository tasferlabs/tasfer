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
        case "theme-change":
            if let theme = body["theme"] as? String {
                updateAppTheme(theme: theme)
            }
        case "setColorScheme":
            if let colorScheme = body["colorScheme"] as? String {
                updateAppColorScheme(colorScheme: colorScheme)
            }
        case "setLocale":
            if let tag = body["locale"] as? String {
                updateAppLocale(tag: tag)
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

    /// Adopt the in-app language picker's choice as the app's language, so text
    /// iOS draws itself — the camera and photo-library permission prompts, the
    /// Settings-bundle page — follows it instead of the device language.
    ///
    /// `AppleLanguages` is resolved by the system when the process launches, so
    /// this lands on next launch rather than immediately. That is acceptable
    /// here: none of the strings it governs are on screen at the moment the
    /// user switches, and the web layer re-pushes on every startup.
    ///
    /// Written only when the value actually changes — this is called on every
    /// launch, and an unconditional write would dirty defaults each time.
    private func updateAppLocale(tag: String) {
        let defaults = UserDefaults.standard
        let current = (defaults.array(forKey: "AppleLanguages") as? [String])?.first
        guard current != tag else { return }
        defaults.set([tag], forKey: "AppleLanguages")
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
