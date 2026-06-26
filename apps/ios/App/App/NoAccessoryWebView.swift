import UIKit
import WebKit
import ObjectiveC

// ===========================================================================
// Native keyboard accessory toolbar
// ===========================================================================
// On iOS the formatting toolbar is a native `inputAccessoryView` glued to the
// keyboard by UIKit, instead of the in-webview React MobileKeyboardToolbar
// (which Android and the web still use). UIKit shows/hides it perfectly in sync
// with the keyboard — no JS timing — which is why it is reliable where the
// web-positioned bar was not.
//
// All of this lives in this single file (rather than new files) because the
// Xcode project references sources explicitly in project.pbxproj; keeping the
// new types here avoids touching that file. Swift has no per-file privacy, so
// `KeyboardAccessoryView` / `KeyboardToolbarBridge` are usable from
// CypherViewController.swift.
//
// Data flow:
//   • web → native: `window.webkit.messageHandlers.KeyboardToolbar.postMessage`
//     sends the standard MobileToolbarModel used by Android.
//   • native → web: button taps call `window.__cypherKeyboardAction(action)`
//     with the same action object emitted by the React toolbar.

// MARK: - WKWebView ↔ accessory association

private var cypherAccessoryKey: UInt8 = 0

extension WKWebView {
    /// Lazily-created native keyboard toolbar bound to this web view. Both the
    /// swizzled `inputAccessoryView` getter and the bridge resolve the same
    /// instance through this associated object.
    var cypherKeyboardAccessory: KeyboardAccessoryView {
        if let existing = objc_getAssociatedObject(self, &cypherAccessoryKey)
            as? KeyboardAccessoryView
        {
            return existing
        }
        let view = KeyboardAccessoryView(webView: self)
        objc_setAssociatedObject(
            self, &cypherAccessoryKey, view, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
        return view
    }
}

extension UIView {
    /// Walk up the view hierarchy to the enclosing `WKWebView`. The actual first
    /// responder is a private `WKContentView` nested inside `WKWebView.scrollView`.
    func cypherEnclosingWebView() -> WKWebView? {
        var current: UIView? = self
        while let view = current {
            if let webView = view as? WKWebView { return webView }
            current = view.superview
        }
        return nil
    }
}

// MARK: - WKWebView subclass + swizzle

/// WKWebView subclass that replaces the default iOS input accessory bar (the
/// up/down/Done shortcuts row) with our custom `KeyboardAccessoryView`.
///
/// Overriding `inputAccessoryView` on WKWebView is not enough — the first
/// responder is an internal `WKContentView`, so we swizzle its
/// `inputAccessoryView` getter at load time.
class NoAccessoryWebView: WKWebView {

    override var inputAccessoryView: UIView? { nil }

    private static let swizzleOnce: Void = {
        guard let wkContentViewClass = NSClassFromString("WKContentView") else { return }
        let original = class_getInstanceMethod(
            wkContentViewClass, #selector(getter: UIResponder.inputAccessoryView))
        let replacement = class_getInstanceMethod(
            NoAccessoryWebView.self, #selector(cypherAccessoryView))
        if let original = original, let replacement = replacement {
            method_exchangeImplementations(original, replacement)
        }
    }()

    override func didMoveToWindow() {
        super.didMoveToWindow()
        _ = NoAccessoryWebView.swizzleOnce
    }

    /// Swizzled onto `WKContentView.inputAccessoryView` — at call time `self` is
    /// the `WKContentView`, not this subclass. UIKit asks for this view while it
    /// is attaching the keyboard, so always return the accessory. Gating this on
    /// JS keyboard state creates a race where the first request returns nil and
    /// UIKit never installs the toolbar.
    @objc private func cypherAccessoryView() -> UIView? {
        guard let webView = cypherEnclosingWebView() else { return nil }
        return webView.cypherKeyboardAccessory
    }
}

// MARK: - Accessory view

/// Existing native keyboard accessory backend. Its contents are built entirely
/// from the standard MobileToolbarModel supplied by the web app.
final class KeyboardAccessoryView: UIView {

    private weak var webView: WKWebView?
    private let barHeight: CGFloat = 48

    private let scrollView = UIScrollView()
    private let row = UIStackView()
    private let fixedRow = UIStackView()

    private let normalTint = UIColor(named: "MutedForeground") ?? .secondaryLabel
    private let activeTint = UIColor(named: "Primary") ?? .label
    private let borderColor = UIColor(named: "Border") ?? .separator

    init(webView: WKWebView) {
        self.webView = webView
        super.init(
            frame: CGRect(x: 0, y: 0, width: UIScreen.main.bounds.width, height: barHeight))
        autoresizingMask = .flexibleWidth
        backgroundColor = UIColor(named: "Background") ?? .systemBackground
        buildUI()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override var intrinsicContentSize: CGSize {
        CGSize(width: UIView.noIntrinsicMetric, height: barHeight)
    }

    // MARK: Build

    private func buildUI() {
        let topBorder = UIView()
        topBorder.backgroundColor = borderColor
        topBorder.translatesAutoresizingMaskIntoConstraints = false
        addSubview(topBorder)

        configureRow(row)
        configureRow(fixedRow)

        scrollView.alwaysBounceHorizontal = true
        scrollView.alwaysBounceVertical = false
        scrollView.showsHorizontalScrollIndicator = true
        scrollView.showsVerticalScrollIndicator = false
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        scrollView.addSubview(row)
        addSubview(scrollView)
        addSubview(fixedRow)

        NSLayoutConstraint.activate([
            topBorder.topAnchor.constraint(equalTo: topAnchor),
            topBorder.leadingAnchor.constraint(equalTo: leadingAnchor),
            topBorder.trailingAnchor.constraint(equalTo: trailingAnchor),
            topBorder.heightAnchor.constraint(equalToConstant: 0.5),

            scrollView.topAnchor.constraint(equalTo: topAnchor),
            scrollView.bottomAnchor.constraint(equalTo: bottomAnchor),
            scrollView.leadingAnchor.constraint(
                equalTo: safeAreaLayoutGuide.leadingAnchor, constant: 4),
            scrollView.trailingAnchor.constraint(equalTo: fixedRow.leadingAnchor),

            row.topAnchor.constraint(equalTo: scrollView.contentLayoutGuide.topAnchor),
            row.bottomAnchor.constraint(equalTo: scrollView.contentLayoutGuide.bottomAnchor),
            row.leadingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.leadingAnchor),
            row.trailingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.trailingAnchor),
            row.heightAnchor.constraint(equalTo: scrollView.frameLayoutGuide.heightAnchor),

            fixedRow.topAnchor.constraint(equalTo: topAnchor),
            fixedRow.bottomAnchor.constraint(equalTo: bottomAnchor),
            fixedRow.trailingAnchor.constraint(
                equalTo: safeAreaLayoutGuide.trailingAnchor, constant: -4),
        ])
    }

    private func configureRow(_ stack: UIStackView) {
        stack.axis = .horizontal
        stack.alignment = .center
        stack.spacing = 2
        stack.translatesAutoresizingMaskIntoConstraints = false
    }

    private func makeButton(
        icon: String,
        label: String,
        enabled: Bool,
        active: Bool,
        action: [String: Any]
    ) -> UIButton {
        let button = UIButton(type: .system)
        button.setImage(UIImage(named: icon)?.withRenderingMode(.alwaysTemplate), for: .normal)
        button.accessibilityLabel = label
        button.isEnabled = enabled
        button.alpha = enabled ? 1.0 : 0.3
        button.tintColor = active ? activeTint : normalTint
        button.translatesAutoresizingMaskIntoConstraints = false
        button.widthAnchor.constraint(equalToConstant: 40).isActive = true
        button.heightAnchor.constraint(equalToConstant: 40).isActive = true
        button.addAction(UIAction { [weak self] _ in self?.dispatch(action) }, for: .touchUpInside)
        return button
    }

    private func makeMenu(_ item: [String: Any]) -> UIButton? {
        guard let icon = item["icon"] as? String,
            let label = item["label"] as? String,
            let selected = item["selected"] as? String,
            let rawOptions = item["options"] as? [[String: Any]]
        else { return nil }

        let button = UIButton(type: .system)
        button.setImage(UIImage(named: icon)?.withRenderingMode(.alwaysTemplate), for: .normal)
        button.accessibilityLabel = label
        button.tintColor = normalTint
        button.imageView?.contentMode = .scaleAspectFit
        button.translatesAutoresizingMaskIntoConstraints = false
        button.widthAnchor.constraint(equalToConstant: 44).isActive = true
        button.heightAnchor.constraint(equalToConstant: 40).isActive = true
        button.showsMenuAsPrimaryAction = true
        // The accessory sits at the bottom of the screen, so this menu opens
        // upward. UIKit's default `.automatic` element order reverses the items
        // when a menu presents above its anchor — which flips the usage-ordered
        // options the web app sends (most- to least-common). The clean fix,
        // `preferredElementOrder = .fixed`, needs the iOS 16 SDK; this target
        // still builds against iOS 15, so instead pre-reverse the options here.
        // `.automatic` then reverses them back, leaving the menu reading
        // top-to-bottom in the same order as the in-webview bar.
        button.menu = UIMenu(
            title: "",
            children: rawOptions.reversed().compactMap { option -> UIAction? in
                guard let id = option["id"] as? String,
                    let label = option["label"] as? String,
                    let action = option["action"] as? [String: Any]
                else { return nil }
                // The icon is optional: language options are label-only.
                let image = (option["icon"] as? String).flatMap {
                    UIImage(named: $0)?.withRenderingMode(.alwaysTemplate)
                }
                return UIAction(
                    title: label,
                    image: image,
                    state: id == selected ? .on : .off
                ) { [weak self] _ in self?.dispatch(action) }
            })
        return button
    }

    private func makeDivider() -> UIView {
        let container = UIView()
        container.translatesAutoresizingMaskIntoConstraints = false
        let line = UIView()
        line.backgroundColor = borderColor
        line.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(line)
        NSLayoutConstraint.activate([
            container.widthAnchor.constraint(equalToConstant: 9),
            line.widthAnchor.constraint(equalToConstant: 1),
            line.heightAnchor.constraint(equalToConstant: 24),
            line.centerXAnchor.constraint(equalTo: container.centerXAnchor),
            line.centerYAnchor.constraint(equalTo: container.centerYAnchor),
        ])
        return container
    }

    // MARK: Math chip row

    /// The contextual math row: a pinned `\`-query prefix (live state), the
    /// matching construct chips (pre-rendered glyph assets), or a clear "no
    /// match" when a typed command resolves to nothing. Mirrors the web bar.
    private func addMathChips(_ mathRow: [String: Any], to stack: UIStackView) {
        let query = mathRow["query"] as? String
        let chips = mathRow["chips"] as? [[String: Any]] ?? []

        if let query = query {
            stack.addArrangedSubview(makeQueryLabel("\\" + query))
        }

        if chips.isEmpty {
            let text = mathRow["noMatchLabel"] as? String ?? ""
            stack.addArrangedSubview(makeMutedLabel(text))
            return
        }

        for (index, chip) in chips.enumerated() {
            guard let asset = chip["asset"] as? String,
                let latex = chip["latex"] as? String
            else { continue }
            // In the live state the leftmost chip is the top match.
            let highlighted = query != nil && index == 0
            stack.addArrangedSubview(
                makeChipButton(
                    asset: asset,
                    latex: latex,
                    name: chip["name"] as? String ?? "",
                    highlighted: highlighted))
        }
    }

    private func makeChipButton(
        asset: String,
        latex: String,
        name: String,
        highlighted: Bool
    ) -> UIButton {
        let glyphHeight: CGFloat = 22
        let button = UIButton(type: .system)
        let image = UIImage(named: asset)?.withRenderingMode(.alwaysTemplate)
        button.setImage(image, for: .normal)
        button.accessibilityLabel = name
        button.tintColor = highlighted ? activeTint : normalTint
        button.imageView?.contentMode = .scaleAspectFit
        button.contentEdgeInsets = UIEdgeInsets(top: 9, left: 10, bottom: 9, right: 10)
        button.translatesAutoresizingMaskIntoConstraints = false

        // Uniform glyph height; width follows the asset's aspect ratio so a tall
        // construct (a fraction) and a small one (a Greek letter) read alike.
        let size = image?.size ?? CGSize(width: glyphHeight, height: glyphHeight)
        let aspect = size.height > 0 ? size.width / size.height : 1
        NSLayoutConstraint.activate([
            button.heightAnchor.constraint(equalToConstant: 40),
            button.widthAnchor.constraint(equalToConstant: max(44, glyphHeight * aspect + 20)),
        ])

        if highlighted {
            button.backgroundColor = activeTint.withAlphaComponent(0.14)
            button.layer.cornerRadius = 8
        }

        button.addAction(
            UIAction { [weak self] _ in
                self?.dispatch(["type": "insert-math-command", "latex": latex])
            }, for: .touchUpInside)
        return button
    }

    private func makeQueryLabel(_ text: String) -> UIView {
        let label = UILabel()
        label.text = text
        label.font = .monospacedSystemFont(ofSize: 13, weight: .regular)
        label.textColor = normalTint
        label.translatesAutoresizingMaskIntoConstraints = false
        label.setContentHuggingPriority(.required, for: .horizontal)

        let container = UIView()
        container.translatesAutoresizingMaskIntoConstraints = false
        container.backgroundColor = UIColor(named: "Muted") ?? .secondarySystemFill
        container.layer.cornerRadius = 6
        container.addSubview(label)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 8),
            label.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -8),
            label.centerYAnchor.constraint(equalTo: container.centerYAnchor),
            container.heightAnchor.constraint(equalToConstant: 26),
        ])
        return container
    }

    private func makeMutedLabel(_ text: String) -> UIView {
        let label = UILabel()
        label.text = text
        label.font = .systemFont(ofSize: 14)
        label.textColor = normalTint
        label.translatesAutoresizingMaskIntoConstraints = false
        label.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let container = UIView()
        container.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(label)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 12),
            label.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -12),
            label.centerYAnchor.constraint(equalTo: container.centerYAnchor),
            container.heightAnchor.constraint(equalToConstant: 40),
        ])
        return container
    }

    /// Rebuild from the same renderer-neutral object used by Android.
    func applyModel(_ model: [String: Any]) {
        guard model["version"] as? Int == 1,
            let items = model["items"] as? [[String: Any]]
        else { return }

        removeArrangedSubviews(from: row)
        removeArrangedSubviews(from: fixedRow)

        // Present in math context only. The native bar can't draw the web bar's
        // live SVG chip row, so it renders pre-baked glyph assets instead.
        let mathRow = model["mathRow"] as? [String: Any]

        var addRemainingItemsToFixedRow = false
        for item in items {
            guard let kind = item["kind"] as? String else { continue }
            if item["id"] as? String == "dismiss-divider" {
                addRemainingItemsToFixedRow = true
            }

            let destination = addRemainingItemsToFixedRow ? fixedRow : row

            // The math-command button's slot becomes the contextual chip row.
            if item["id"] as? String == "math-command", let mathRow = mathRow {
                addMathChips(mathRow, to: destination)
                continue
            }

            switch kind {
            case "button":
                guard let icon = item["icon"] as? String,
                    let label = item["label"] as? String,
                    let action = item["action"] as? [String: Any]
                else { continue }
                destination.addArrangedSubview(
                    makeButton(
                        icon: icon,
                        label: label,
                        enabled: item["enabled"] as? Bool ?? true,
                        active: item["active"] as? Bool ?? false,
                        action: action))
            case "menu":
                if let button = makeMenu(item) { destination.addArrangedSubview(button) }
            case "divider":
                destination.addArrangedSubview(makeDivider())
            case "spacer":
                // A flexible spacer is useful in a non-scrolling toolbar, but
                // inside a scroll view it creates ambiguous content width.
                continue
            default:
                continue
            }
        }

        // iOS does not use model.visible to attach/detach the accessory. UIKit
        // owns that lifecycle and displays this view only with the keyboard.
    }

    private func removeArrangedSubviews(from stack: UIStackView) {
        stack.arrangedSubviews.forEach {
            stack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }
    }

    private func dispatch(_ action: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(action),
            let data = try? JSONSerialization.data(withJSONObject: action),
            let json = String(data: data, encoding: .utf8)
        else { return }
        webView?.evaluateJavaScript(
            "window.__cypherKeyboardAction && window.__cypherKeyboardAction(\(json))",
            completionHandler: nil)
    }
}

// MARK: - Bridge

/// Receives the standard toolbar object and passes it to the existing accessory.
final class KeyboardToolbarBridge: NSObject, WKScriptMessageHandler {
    weak var webView: WKWebView?

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        guard let model = message.body as? [String: Any],
            let accessory = webView?.cypherKeyboardAccessory
        else { return }
        accessory.applyModel(model)
    }
}
