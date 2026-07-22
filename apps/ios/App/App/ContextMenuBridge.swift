import UIKit
import WebKit

/// Presents a native edit menu for the editor's long-press context menu.
///
/// The web host builds the same menu items it would render in its own popover,
/// then posts a serializable model here (see `app/nativeContextMenu.ts` and the
/// `editor.showContextMenu` bridge method). We render it with
/// `UIEditMenuInteraction` — the modern selection bubble — and resolve the JS
/// promise with the chosen item's id, or null when dismissed without a pick.
///
/// `UIEditMenuInteraction` is iOS 16+, so the whole type is gated; the JS bridge
/// method is only injected on iOS 16+ as well, keeping the two in lockstep.
@available(iOS 16.0, *)
final class ContextMenuBridge: NSObject, WKScriptMessageHandler, UIEditMenuInteractionDelegate {
    weak var webView: WKWebView?

    /// Created lazily and reused; one interaction attached to the web view.
    private var interaction: UIEditMenuInteraction?
    /// The JS callback id awaiting resolution, or nil when no menu is pending.
    private var pendingCallbackId: String?
    /// The serializable item model for the menu currently being presented.
    private var menuItems: [[String: Any]] = []
    /// Set when an item action fires, so the dismiss handler doesn't also
    /// resolve the promise with null.
    private var didChoose = false

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        guard let body = message.body as? [String: Any],
            let callbackId = body["callbackId"] as? String,
            let model = body["model"] as? [[String: Any]],
            let anchor = body["anchor"] as? [String: Any],
            let webView = webView
        else { return }

        // A new request supersedes any still-open menu: resolve the old one as
        // dismissed before taking over the pending slot.
        resolvePending(with: nil)

        pendingCallbackId = callbackId
        menuItems = model
        didChoose = false

        let interaction: UIEditMenuInteraction
        if let existing = self.interaction {
            interaction = existing
        } else {
            interaction = UIEditMenuInteraction(delegate: self)
            webView.addInteraction(interaction)
            self.interaction = interaction
        }

        // The anchor arrives as viewport-relative CSS pixels, which map 1:1 to
        // points in the web view's coordinate space (no zoom, full-screen view).
        let point = CGPoint(x: doubleValue(anchor["x"]), y: doubleValue(anchor["y"]))
        let configuration = UIEditMenuConfiguration(identifier: nil, sourcePoint: point)
        interaction.presentEditMenu(with: configuration)
    }

    // MARK: - UIEditMenuInteractionDelegate

    /// Replace the system suggestions entirely with our own menu.
    func editMenuInteraction(
        _ interaction: UIEditMenuInteraction,
        menuFor configuration: UIEditMenuConfiguration,
        suggestedActions: [UIMenuElement]
    ) -> UIMenu? {
        UIMenu(title: "", children: buildElements(menuItems))
    }

    func editMenuInteraction(
        _ interaction: UIEditMenuInteraction,
        willDismissMenuFor configuration: UIEditMenuConfiguration,
        animator: any UIEditMenuInteractionAnimating
    ) {
        // Resolve null on dismissal, but defer one runloop turn so a tapped
        // action's handler wins the race and marks `didChoose`. `resolvePending`
        // clears the pending id on first call, so a double-resolve is harmless.
        DispatchQueue.main.async { [weak self] in
            guard let self = self, !self.didChoose else { return }
            self.resolvePending(with: nil)
        }
    }

    // MARK: - Menu construction

    private func buildElements(_ items: [[String: Any]]) -> [UIMenuElement] {
        items.compactMap { item -> UIMenuElement? in
            guard let id = item["id"] as? String,
                let label = item["label"] as? String
            else { return nil }

            // Icon hints are SF Symbol names; an unknown name simply yields no
            // image, which is an acceptable text-only row.
            let image = (item["icon"] as? String).flatMap { UIImage(systemName: $0) }

            if let children = item["children"] as? [[String: Any]] {
                return UIMenu(
                    title: label, image: image, children: buildElements(children))
            }

            let enabled = item["enabled"] as? Bool ?? true
            let checked = item["checked"] as? Bool ?? false
            return UIAction(
                title: label,
                image: image,
                attributes: enabled ? [] : .disabled,
                state: checked ? .on : .off
            ) { [weak self] _ in
                self?.choose(id)
            }
        }
    }

    private func choose(_ id: String) {
        didChoose = true
        resolvePending(with: id)
    }

    /// Resolve the pending JS promise with `id` (or null) and clear the slot.
    private func resolvePending(with id: String?) {
        guard let callbackId = pendingCallbackId else { return }
        pendingCallbackId = nil

        let payload: String
        if let id = id,
            let data = try? JSONSerialization.data(withJSONObject: ["id": id]),
            let json = String(data: data, encoding: .utf8)
        {
            payload = json
        } else {
            payload = "{\"id\":null}"
        }

        // callbackId is generated by our own JS from a counter + timestamp, so
        // it contains no characters that need escaping inside this expression.
        webView?.evaluateJavaScript(
            "window.__nativeContextMenuCallbacks && window.__nativeContextMenuCallbacks.get('\(callbackId)') && window.__nativeContextMenuCallbacks.get('\(callbackId)')(\(payload))",
            completionHandler: nil)
    }

    private func doubleValue(_ value: Any?) -> CGFloat {
        if let d = value as? Double { return CGFloat(d) }
        if let i = value as? Int { return CGFloat(i) }
        if let n = value as? NSNumber { return CGFloat(truncating: n) }
        return 0
    }
}
