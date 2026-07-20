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
// TasferViewController.swift.
//
// Data flow:
//   • web → native: `window.webkit.messageHandlers.KeyboardToolbar.postMessage`
//     sends the standard MobileToolbarModel used by Android.
//   • native → web: button taps call `window.__tasferKeyboardAction(action)`
//     with the same action object emitted by the React toolbar.

// MARK: - WKWebView ↔ accessory association

private var tasferAccessoryKey: UInt8 = 0
private var tasferAccessoryEnabledKey: UInt8 = 0
private var tasferHomeIndicatorInsetKey: UInt8 = 0

extension WKWebView {
    /// The device's home-indicator bottom inset, captured by the hosting view
    /// controller while no keyboard is docked (see
    /// `TasferViewController.captureHomeIndicatorInset`).
    ///
    /// The accessory can't read this from any live safe area: once a hardware
    /// keyboard docks the bar over the home indicator, both the app window and
    /// the accessory's own `safeAreaInsets.bottom` collapse to 0 (the bar now
    /// occupies that region). This cached value is the only reliable source of
    /// the gap the docked bar must reserve.
    var tasferHomeIndicatorInset: CGFloat {
        get {
            (objc_getAssociatedObject(self, &tasferHomeIndicatorInsetKey) as? NSNumber)
                .map { CGFloat($0.doubleValue) } ?? 0
        }
        set {
            objc_setAssociatedObject(
                self, &tasferHomeIndicatorInsetKey, NSNumber(value: Double(newValue)),
                .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
        }
    }

    /// Lazily-created native keyboard toolbar bound to this web view. Both the
    /// swizzled `inputAccessoryView` getter and the bridge resolve the same
    /// instance through this associated object.
    var tasferKeyboardAccessory: KeyboardAccessoryView {
        if let existing = objc_getAssociatedObject(self, &tasferAccessoryKey)
            as? KeyboardAccessoryView
        {
            return existing
        }
        let view = KeyboardAccessoryView(webView: self)
        objc_setAssociatedObject(
            self, &tasferAccessoryKey, view, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
        return view
    }

    /// Whether the custom keyboard accessory should be attached to the current
    /// first responder. The web app sets this true only while the canvas
    /// editor's input surface is focused; every other field (find bar, dialogs,
    /// settings) leaves it false and gets the plain keyboard. Defaults to false.
    var tasferAccessoryEnabled: Bool {
        (objc_getAssociatedObject(self, &tasferAccessoryEnabledKey) as? NSNumber)?
            .boolValue ?? false
    }

    /// Update the accessory-enabled flag and, when it changes, ask UIKit to
    /// re-query `inputAccessoryView` so the bar attaches/detaches immediately.
    /// The first `inputAccessoryView` request can race ahead of the web app's
    /// focus message, so reloading here is what makes the toggle reliable.
    func setTasferAccessoryEnabled(_ enabled: Bool) {
        guard tasferAccessoryEnabled != enabled else { return }
        objc_setAssociatedObject(
            self, &tasferAccessoryEnabledKey, NSNumber(value: enabled),
            .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
        tasferContentView?.reloadInputViews()
    }

    /// The private `WKContentView` that is the real first responder for web text
    /// input. `reloadInputViews()` only takes effect on the first responder, so
    /// the accessory toggle targets this view rather than the `WKWebView`.
    fileprivate var tasferContentView: UIView? {
        func find(_ view: UIView) -> UIView? {
            if String(describing: type(of: view)) == "WKContentView" { return view }
            for sub in view.subviews {
                if let match = find(sub) { return match }
            }
            return nil
        }
        return find(scrollView)
    }
}

extension UIView {
    /// Walk up the view hierarchy to the enclosing `WKWebView`. The actual first
    /// responder is a private `WKContentView` nested inside `WKWebView.scrollView`.
    func tasferEnclosingWebView() -> WKWebView? {
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
            NoAccessoryWebView.self, #selector(tasferAccessoryView))
        if let original = original, let replacement = replacement {
            method_exchangeImplementations(original, replacement)
        }
    }()

    override func didMoveToWindow() {
        super.didMoveToWindow()
        _ = NoAccessoryWebView.swizzleOnce
    }

    /// Swizzled onto `WKContentView.inputAccessoryView` — at call time `self` is
    /// the `WKContentView`, not this subclass. Return the accessory only while
    /// the canvas editor surface is focused; every other input (find bar,
    /// dialogs, settings fields) returns nil and keeps the plain keyboard. The
    /// web app sets `tasferAccessoryEnabled` on focus and calls
    /// `reloadInputViews()`, so a stale first request self-corrects rather than
    /// leaving the toolbar permanently installed or missing.
    @objc private func tasferAccessoryView() -> UIView? {
        guard let webView = tasferEnclosingWebView(), webView.tasferAccessoryEnabled
        else { return nil }
        return webView.tasferKeyboardAccessory
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

    /// Home-indicator inset currently reserved below the controls. Non-zero only
    /// while the bar is docked at the screen bottom by a hardware keyboard (see
    /// `resolveBottomInset`). Drives both `intrinsicContentSize` and the content
    /// rows' bottom constant so the controls clear the home indicator.
    private var resolvedBottomInset: CGFloat = 0
    /// The content rows' bottom pins, held so their constant can track
    /// `resolvedBottomInset` without rebuilding the layout.
    private var contentBottomConstraints: [NSLayoutConstraint] = []

    private let normalTint = UIColor(named: "MutedForeground") ?? .secondaryLabel
    private let activeTint = UIColor(named: "Primary") ?? .label
    private let borderColor = UIColor(named: "Border") ?? .separator

    init(webView: WKWebView) {
        self.webView = webView
        super.init(
            frame: CGRect(x: 0, y: 0, width: UIScreen.main.bounds.width, height: barHeight))
        // `.flexibleHeight` is what makes UIKit's keyboard layout treat this
        // accessory as self-sizing and read `intrinsicContentSize`. Without it
        // the bar is locked to its initial `frame.height` and the intrinsic
        // size (and the docked home-indicator growth it carries) is ignored.
        autoresizingMask = [.flexibleWidth, .flexibleHeight]
        backgroundColor = UIColor(named: "Background") ?? .systemBackground
        buildUI()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override var intrinsicContentSize: CGSize {
        // Grow the bar by the docked home-indicator inset so its controls clear
        // the home indicator. `resolvedBottomInset` is 0 while the bar floats
        // above the software keyboard (which already fills the safe area) and
        // the measured inset only when a hardware keyboard docks it at the
        // screen bottom — see `resolveBottomInset`.
        CGSize(width: UIView.noIntrinsicMetric, height: barHeight + resolvedBottomInset)
    }

    override func safeAreaInsetsDidChange() {
        super.safeAreaInsetsDidChange()
        refreshBottomInset()
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        refreshBottomInset()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        // The bar's frame moves between "floating above the keyboard" and
        // "docked at the screen bottom" as the keyboard shows/hides or a
        // hardware keyboard connects; re-resolve the inset on every layout pass.
        refreshBottomInset()
        let fmaxY = window.map { convert(bounds, to: $0.screen.coordinateSpace).maxY } ?? -1
        let smaxY = window?.screen.bounds.maxY ?? -1
        NSLog("TASFERKBD layout ownSafeBottom=\(safeAreaInsets.bottom) cached=\(webView?.tasferHomeIndicatorInset ?? -1) resolved=\(resolvedBottomInset) intrinsic=\(intrinsicContentSize.height) frame=\(frame) fmaxY=\(fmaxY) smaxY=\(smaxY) window=\(window != nil)")
    }

    /// Re-measure the docked home-indicator inset and, when it changes, update
    /// both the content rows' bottom pins and the bar's intrinsic height.
    private func refreshBottomInset() {
        let inset = resolveBottomInset()
        guard inset != resolvedBottomInset else { return }
        resolvedBottomInset = inset
        for constraint in contentBottomConstraints { constraint.constant = -inset }
        invalidateIntrinsicContentSize()
        // UIKit derives the accessory's height (`_UIKBAutolayoutHeightConstraint`)
        // from `intrinsicContentSize` only when it installs the accessory, and
        // never re-reads it on `invalidateIntrinsicContentSize()` alone — so the
        // stale height would pin the bar and break the inset constraint. Re-install
        // the input views on the next runloop so the keyboard rebuilds that height
        // from the new intrinsic size. Coalesced so a single transition triggers
        // one reload rather than one per layout pass.
        scheduleInputViewReload()
    }

    private var inputViewReloadScheduled = false

    private func scheduleInputViewReload() {
        guard !inputViewReloadScheduled else { return }
        inputViewReloadScheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.inputViewReloadScheduled = false
            self.webView?.tasferContentView?.reloadInputViews()
        }
    }

    /// Home-indicator inset to reserve below the controls.
    ///
    /// The accessory's own `safeAreaInsets.bottom` stays 0 even when a hardware
    /// keyboard docks it at the bottom of the screen — UIKit does not extend the
    /// keyboard host's safe area into a floating input accessory — so the
    /// controls would overlap the home indicator. Reserve the cached
    /// home-indicator inset (captured by the view controller before the bar
    /// docked), but only while the bar is actually docked on the screen's bottom
    /// edge. While it floats atop the software keyboard the keyboard already
    /// fills the safe area, so no growth is wanted.
    private func resolveBottomInset() -> CGFloat {
        guard let screen = window?.screen else { return 0 }
        let frameInScreen = convert(bounds, to: screen.coordinateSpace)
        let dockedAtBottom = frameInScreen.maxY >= screen.bounds.maxY - 0.5
        guard dockedAtBottom else { return 0 }
        // Use the home-indicator inset captured before the bar docked. Reading
        // any live safe area here returns 0, because the docked bar already
        // covers the home-indicator region.
        return webView?.tasferHomeIndicatorInset ?? 0
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

        // Pin the content rows to the view's own bottom, offset up by the
        // docked home-indicator inset. `safeAreaLayoutGuide.bottomAnchor` can't
        // be used here: the accessory's own bottom safe area reads 0 while a
        // hardware keyboard docks it at the screen bottom, so the inset is
        // measured from the app window and applied through this constant (see
        // `refreshBottomInset`). Horizontal edges keep the safe-area guide for
        // the landscape notch.
        let scrollBottom = scrollView.bottomAnchor.constraint(equalTo: bottomAnchor)
        let fixedBottom = fixedRow.bottomAnchor.constraint(equalTo: bottomAnchor)
        contentBottomConstraints = [scrollBottom, fixedBottom]

        NSLayoutConstraint.activate([
            topBorder.topAnchor.constraint(equalTo: topAnchor),
            topBorder.leadingAnchor.constraint(equalTo: leadingAnchor),
            topBorder.trailingAnchor.constraint(equalTo: trailingAnchor),
            topBorder.heightAnchor.constraint(equalToConstant: 0.5),

            scrollView.topAnchor.constraint(equalTo: topAnchor),
            scrollBottom,
            scrollView.leadingAnchor.constraint(
                equalTo: safeAreaLayoutGuide.leadingAnchor, constant: 4),
            scrollView.trailingAnchor.constraint(equalTo: fixedRow.leadingAnchor),

            row.topAnchor.constraint(equalTo: scrollView.contentLayoutGuide.topAnchor),
            row.bottomAnchor.constraint(equalTo: scrollView.contentLayoutGuide.bottomAnchor),
            row.leadingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.leadingAnchor),
            row.trailingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.trailingAnchor),
            row.heightAnchor.constraint(equalTo: scrollView.frameLayoutGuide.heightAnchor),

            fixedRow.topAnchor.constraint(equalTo: topAnchor),
            fixedBottom,
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
        // Light up the trigger (e.g. the overflow "more" menu) when the model
        // flags it active because one of its hidden controls is on.
        button.tintColor = (item["active"] as? Bool ?? false) ? activeTint : normalTint
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

    /// The contextual math row: the matching construct chips (pre-rendered glyph
    /// assets), or a clear "no match" when a typed command resolves to nothing.
    /// The toolbar is the only math picker on iOS, so it stays a plain palette —
    /// no `\`-query echo and no top-match highlight.
    private func addMathChips(_ mathRow: [String: Any], to stack: UIStackView) {
        let chips = mathRow["chips"] as? [[String: Any]] ?? []

        if chips.isEmpty {
            let text = mathRow["noMatchLabel"] as? String ?? ""
            stack.addArrangedSubview(makeMutedLabel(text))
            return
        }

        for chip in chips {
            guard let asset = chip["asset"] as? String,
                let latex = chip["latex"] as? String
            else { continue }
            stack.addArrangedSubview(
                makeChipButton(
                    asset: asset,
                    latex: latex,
                    name: chip["name"] as? String ?? ""))
        }
    }

    private func makeChipButton(
        asset: String,
        latex: String,
        name: String
    ) -> UIButton {
        let glyphHeight: CGFloat = 22
        let button = UIButton(type: .system)
        let image = UIImage(named: asset)?.withRenderingMode(.alwaysTemplate)
        button.setImage(image, for: .normal)
        button.accessibilityLabel = name
        button.tintColor = normalTint
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

        button.addAction(
            UIAction { [weak self] _ in
                self?.dispatch(["type": "insert-math-command", "latex": latex])
            }, for: .touchUpInside)
        return button
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
            if item["id"] as? String == "fixed-row-start" {
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
            "window.__tasferKeyboardAction && window.__tasferKeyboardAction(\(json))",
            completionHandler: nil)
    }
}

// MARK: - Bridge

/// Receives the standard toolbar object and the editor focus signal. Registered
/// under both `KeyboardToolbar` (model) and `KeyboardToolbarFocus` (enable flag);
/// `message.name` selects which.
final class KeyboardToolbarBridge: NSObject, WKScriptMessageHandler {
    weak var webView: WKWebView?

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        guard let webView = webView else { return }
        switch message.name {
        case "KeyboardToolbarFocus":
            // The canvas editor surface gained or lost focus. Only while it is
            // focused does iOS attach the formatting accessory; other inputs
            // keep the plain keyboard.
            webView.setTasferAccessoryEnabled((message.body as? NSNumber)?.boolValue ?? false)
        default:
            guard let model = message.body as? [String: Any] else { return }
            webView.tasferKeyboardAccessory.applyModel(model)
        }
    }
}
