import GameController
import UIKit
import WebKit

extension UIColor {
    func toHex() -> String {
        guard let components = cgColor.components, components.count >= 3 else {
            return "#000000"
        }
        let r = Float(components[0])
        let g = Float(components[1])
        let b = Float(components[2])
        return String(
            format: "#%02lX%02lX%02lX", lroundf(r * 255), lroundf(g * 255), lroundf(b * 255))
    }
}

// Custom UITextField that hides the keyboard accessory bar
class NoAccessoryTextField: UITextField {
    override var inputAssistantItem: UITextInputAssistantItem {
        let item = super.inputAssistantItem
        item.leadingBarButtonGroups = []
        item.trailingBarButtonGroups = []
        return item
    }

    override var keyboardAppearance: UIKeyboardAppearance {
        get { return .default }
        set {}
    }
}

class CustomWebView: WKWebView {
    private var islandView: AccessoryIslandView?
    private let dummyTextField = NoAccessoryTextField()
    private var blockTypeInputView: BlockTypeInputView?

    // State
    private var canUndo = false
    private var canRedo = false
    private var isMenuOpen = false
    private var isEditorFocused = false
    private var lastKeyboardHeight: CGFloat = 291
    var currentIconType: String = "format"
    private var hasPhysicalKeyboard = false
    private var isSoftKeyboardVisible = false

    override var inputAccessoryView: UIView? {
        return isEditorFocused ? islandView : nil
    }

    override var inputAssistantItem: UITextInputAssistantItem {
        let item = super.inputAssistantItem
        item.leadingBarButtonGroups = []
        item.trailingBarButtonGroups = []
        return item
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        configureAllTextInputs()
    }

    override init(frame: CGRect, configuration: WKWebViewConfiguration) {
        super.init(frame: frame, configuration: configuration)
        setupDummyInput()
        observeKeyboard()
        detectPhysicalKeyboard()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        setupDummyInput()
        observeKeyboard()
        detectPhysicalKeyboard()
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    private func observeKeyboard() {
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(keyboardWillShow(_:)),
            name: UIResponder.keyboardWillShowNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(keyboardDidShow(_:)),
            name: UIResponder.keyboardDidShowNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(keyboardWillHide(_:)),
            name: UIResponder.keyboardWillHideNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(keyboardDidHide(_:)),
            name: UIResponder.keyboardDidHideNotification,
            object: nil
        )

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(appWillEnterForeground(_:)),
            name: UIApplication.willEnterForegroundNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(appDidBecomeActive(_:)),
            name: UIApplication.didBecomeActiveNotification,
            object: nil
        )

        if #available(iOS 14.0, *) {
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(keyboardDidConnect(_:)),
                name: .GCKeyboardDidConnect,
                object: nil
            )
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(keyboardDidDisconnect(_:)),
                name: .GCKeyboardDidDisconnect,
                object: nil
            )
        }
    }

    @objc private func keyboardWillShow(_ notification: Notification) {
        if let keyboardFrame = notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey]
            as? CGRect
        {
            let screenHeight = UIScreen.main.bounds.height
            let isKeyboardOnScreen = keyboardFrame.origin.y < screenHeight
            let hasSubstantialHeight = keyboardFrame.height > 100
            let isSoftKeyboard = isKeyboardOnScreen && hasSubstantialHeight

            let previousState = isSoftKeyboardVisible
            isSoftKeyboardVisible = isSoftKeyboard
            hasPhysicalKeyboard = !isSoftKeyboard

            if isSoftKeyboard {
                islandView?.isHidden = false
            } else {
                islandView?.isHidden = true
            }

            if previousState != isSoftKeyboardVisible {
                notifyPhysicalKeyboardState()
            }

            if !isMenuOpen && keyboardFrame.height > 200 && isSoftKeyboard {
                let accessoryWithSafeArea = islandView?.frame.height ?? 56
                let keyboardOnlyHeight = keyboardFrame.height - accessoryWithSafeArea

                lastKeyboardHeight = keyboardOnlyHeight
                BlockTypeInputView.cachedKeyboardHeight = keyboardOnlyHeight
                blockTypeInputView?.updateHeight(keyboardOnlyHeight)
            }
        }
    }

    @objc private func keyboardDidShow(_ notification: Notification) {
        if let keyboardFrame = notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey]
            as? CGRect
        {
            let screenHeight = UIScreen.main.bounds.height
            let isKeyboardOnScreen = keyboardFrame.origin.y < screenHeight
            let hasSubstantialHeight = keyboardFrame.height > 100
            let isSoftKeyboard = isKeyboardOnScreen && hasSubstantialHeight

            let previousState = isSoftKeyboardVisible
            isSoftKeyboardVisible = isSoftKeyboard
            hasPhysicalKeyboard = !isSoftKeyboard

            if isSoftKeyboard {
                islandView?.isHidden = false
            } else {
                islandView?.isHidden = true
            }

            if previousState != isSoftKeyboardVisible {
                notifyPhysicalKeyboardState()
            }
        }
    }

    @objc private func keyboardWillHide(_ notification: Notification) {
        isSoftKeyboardVisible = false
        islandView?.isHidden = true
        islandView?.collapseFormattingIfNeeded()
        detectPhysicalKeyboard()
    }

    @objc private func keyboardDidHide(_ notification: Notification) {
        isSoftKeyboardVisible = false
        islandView?.isHidden = true
    }

    @available(iOS 14.0, *)
    @objc private func keyboardDidConnect(_ notification: Notification) {
        // Wait for keyboardWillShow to detect based on frame height
    }

    @available(iOS 14.0, *)
    @objc private func keyboardDidDisconnect(_ notification: Notification) {
        if GCKeyboard.coalesced == nil {
            hasPhysicalKeyboard = false
            notifyPhysicalKeyboardState()
        }
    }

    @objc private func appWillEnterForeground(_ notification: Notification) {
        DispatchQueue.main.async { [weak self] in
            self?.setNeedsLayout()
            self?.layoutIfNeeded()
        }
    }

    @objc private func appDidBecomeActive(_ notification: Notification) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }

            self.isOpaque = true
            self.isOpaque = false

            if let backgroundColor = UIColor(named: "Background") {
                self.backgroundColor = backgroundColor
                self.scrollView.backgroundColor = backgroundColor
            }

            self.setNeedsLayout()
            self.layoutIfNeeded()

            let javascript = """
                window.postMessage({type: 'app-foreground'}, '*');
                """
            self.evaluateJavaScript(javascript, completionHandler: nil)
        }
    }

    private func detectPhysicalKeyboard() {
        let previousState = hasPhysicalKeyboard

        if GCKeyboard.coalesced == nil {
            hasPhysicalKeyboard = false
        }

        if previousState != hasPhysicalKeyboard {
            notifyPhysicalKeyboardState()
        }
    }

    func notifyPhysicalKeyboardState() {
        let javascript = """
            window.postMessage({type: 'physical-keyboard-connected', connected: \(hasPhysicalKeyboard)}, '*');
            """
        evaluateJavaScript(javascript, completionHandler: nil)
    }

    private func setupDummyInput() {
        dummyTextField.isHidden = true
        dummyTextField.autocorrectionType = .no
        dummyTextField.autocapitalizationType = .none
        dummyTextField.spellCheckingType = .no
        addSubview(dummyTextField)

        let menu = BlockTypeInputView()
        menu.onSelect = { [weak self] type in
            self?.applyBlockType(type)
        }
        blockTypeInputView = menu
        dummyTextField.inputView = menu
    }

    func setupAccessoryView() {
        let island = AccessoryIslandView(frame: CGRect(x: 0, y: 0, width: 0, height: 56))

        island.onUndo = { [weak self] in self?.onUndo() }
        island.onRedo = { [weak self] in self?.onRedo() }
        island.onFormat = { [weak self] in self?.onFormat() }
        island.onDismiss = { [weak self] in self?.onDismiss() }

        island.onBlockType = { [weak self] in self?.onFormat() }

        island.onBold = { [weak self] in
            self?.evaluateJavaScript("window.IOSBridge?.toggleBold?.()", completionHandler: nil)
        }
        island.onItalic = { [weak self] in
            self?.evaluateJavaScript("window.IOSBridge?.toggleItalic?.()", completionHandler: nil)
        }
        island.onCode = { [weak self] in
            self?.evaluateJavaScript("window.IOSBridge?.toggleCode?.()", completionHandler: nil)
        }
        island.onStrikethrough = { [weak self] in
            self?.evaluateJavaScript(
                "window.IOSBridge?.toggleStrikethrough?.()", completionHandler: nil)
        }

        island.isHidden = true

        self.islandView = island
        self.dummyTextField.inputAccessoryView = island

        updateToolbarState()
    }

    func updateUndoRedoState(canUndo: Bool, canRedo: Bool) {
        self.canUndo = canUndo
        self.canRedo = canRedo
        DispatchQueue.main.async {
            self.updateToolbarState()
        }
    }

    func updateToolbarState() {
        islandView?.updateState(canUndo: canUndo, canRedo: canRedo, isMenuOpen: isMenuOpen)
    }

    func updateEditorFocus(focused: Bool) {
        DispatchQueue.main.async {
            self.isEditorFocused = focused
            self.reloadInputViews()
        }
    }

    func updateToolbarIcon(iconType: String) {
        DispatchQueue.main.async {
            self.currentIconType = iconType
            self.islandView?.currentIconType = iconType
            self.islandView?.updateIcon(iconType: iconType)
        }
    }

    func updateFormattingState(isBold: Bool, isItalic: Bool, isCode: Bool, isStrikethrough: Bool) {
        DispatchQueue.main.async {
            self.islandView?.updateFormattingState(
                isBold: isBold,
                isItalic: isItalic,
                isCode: isCode,
                isStrikethrough: isStrikethrough
            )
        }
    }

    @objc func onUndo() {
        self.evaluateJavaScript(
            "if(window.IOSBridge && window.IOSBridge.undo) window.IOSBridge.undo()",
            completionHandler: nil)
    }

    @objc func onRedo() {
        self.evaluateJavaScript(
            "if(window.IOSBridge && window.IOSBridge.redo) window.IOSBridge.redo()",
            completionHandler: nil)
    }

    @objc func onFormat() {
        if isMenuOpen {
            isMenuOpen = false
            dummyTextField.resignFirstResponder()
            self.evaluateJavaScript(
                "if(window.IOSBridge && window.IOSBridge.focus) window.IOSBridge.focus()",
                completionHandler: nil)
            updateToolbarState()
        } else {
            self.evaluateJavaScript(
                "(function() { if(window.IOSBridge && window.IOSBridge.onFormatButtonClick) { return window.IOSBridge.onFormatButtonClick(); } return false; })()",
                completionHandler: { result, error in
                    if let handled = result as? Bool, handled {
                        return
                    } else {
                        DispatchQueue.main.async {
                            self.isMenuOpen = true
                            self.dummyTextField.becomeFirstResponder()
                            self.updateToolbarState()
                        }
                    }
                })
        }
    }

    @objc func onDismiss() {
        if isMenuOpen {
            isMenuOpen = false
            dummyTextField.resignFirstResponder()
            self.evaluateJavaScript(
                "if(window.IOSBridge && window.IOSBridge.focus) window.IOSBridge.focus()",
                completionHandler: nil)
        } else {
            self.endEditing(true)
        }
        updateToolbarState()
    }

    func applyBlockType(_ type: String) {
        let js =
            "if(window.IOSBridge && window.IOSBridge.setBlockType) window.IOSBridge.setBlockType('\(type)')"
        evaluateJavaScript(js, completionHandler: nil)

        isMenuOpen = false
        dummyTextField.resignFirstResponder()
        self.evaluateJavaScript(
            "if(window.IOSBridge && window.IOSBridge.focus) window.IOSBridge.focus()",
            completionHandler: nil)

        updateToolbarState()
    }

    func configureAllTextInputs() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            self?.recursivelyConfigureSubviews(self)
        }
    }

    private func recursivelyConfigureSubviews(_ view: UIView?) {
        guard let view = view else { return }

        if let textInput = view as? (UIView & UITextInput) {
            textInput.inputAssistantItem.leadingBarButtonGroups = []
            textInput.inputAssistantItem.trailingBarButtonGroups = []
        }

        for subview in view.subviews {
            recursivelyConfigureSubviews(subview)
        }
    }
}
