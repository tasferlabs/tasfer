import UIKit
import WebKit

/// WKWebView subclass that suppresses the native iOS input accessory bar
/// (the up/down/checkmark row shown above the keyboard by default).
/// The app renders its own toolbar via MobileKeyboardToolbar in React.
///
/// Simply overriding `inputAccessoryView` on WKWebView is not enough — the
/// actual first responder is an internal `WKContentView`, so we swizzle its
/// `inputAccessoryView` property at load time.
class NoAccessoryWebView: WKWebView {

    override var inputAccessoryView: UIView? { nil }

    private static let swizzleOnce: Void = {
        // WKContentView is a private UIView subclass that is the actual first
        // responder inside WKWebView. We swizzle its inputAccessoryView getter
        // to return nil, which removes the shortcuts bar above the keyboard.
        guard let wkContentViewClass = NSClassFromString("WKContentView") else { return }
        let original = class_getInstanceMethod(wkContentViewClass, #selector(getter: UIResponder.inputAccessoryView))
        let replacement = class_getInstanceMethod(NoAccessoryWebView.self, #selector(noAccessoryView))
        if let original = original, let replacement = replacement {
            method_exchangeImplementations(original, replacement)
        }
    }()

    override func didMoveToWindow() {
        super.didMoveToWindow()
        _ = NoAccessoryWebView.swizzleOnce
    }

    @objc private func noAccessoryView() -> UIView? {
        return nil
    }
}
