//
//  ContentView.swift
//  ios
//
//  Created by Hamza Khuswan on 2025-12-28.
//

import SwiftUI
import WebKit
import GameController

extension UIColor {
    func toHex() -> String {
        guard let components = cgColor.components, components.count >= 3 else {
            return "#000000"
        }
        let r = Float(components[0])
        let g = Float(components[1])
        let b = Float(components[2])
        return String(format: "#%02lX%02lX%02lX", lroundf(r * 255), lroundf(g * 255), lroundf(b * 255))
    }
}

struct ContentView: View {
    @State private var isLoading = true
    
    var body: some View {
        ZStack {
            // Background color to prevent white flash
            Color("Background")
                .edgesIgnoringSafeArea(.all)
            
            WebView(url: URL(string: "https://192.168.68.53:5173/")!, isLoading: $isLoading)
                .edgesIgnoringSafeArea(.all)
            
            if isLoading {
                LoadingView()
                    .transition(.opacity)
            }
        }
    }
}

class ImagePickerCoordinator: NSObject, UINavigationControllerDelegate, UIImagePickerControllerDelegate {
    weak var webView: WKWebView?
    weak var presentingViewController: UIViewController?
    
    func openPhotoLibrary() {
        DispatchQueue.main.async {
            self.presentImagePicker(sourceType: .photoLibrary)
        }
    }
    
    func openCamera() {
        DispatchQueue.main.async {
            guard UIImagePickerController.isSourceTypeAvailable(.camera) else {
                return
            }
            self.presentImagePicker(sourceType: .camera)
        }
    }
    
    private func presentImagePicker(sourceType: UIImagePickerController.SourceType) {
        guard let presenter = presentingViewController else {
            return
        }
        
        let picker = UIImagePickerController()
        picker.sourceType = sourceType
        picker.delegate = self
        picker.allowsEditing = false
        
        presenter.present(picker, animated: true)
    }
    
    func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey : Any]) {
        picker.dismiss(animated: true)
        
        guard let image = info[.originalImage] as? UIImage else {
            return
        }
        
        // Convert image to JPEG data
        guard let imageData = image.jpegData(compressionQuality: 0.8) else {
            return
        }
        
        // Convert to base64
        let base64String = imageData.base64EncodedString()
        let dataUrl = "data:image/jpeg;base64,\(base64String)"
        
        // Send to web view
        let escapedData = dataUrl.replacingOccurrences(of: "'", with: "\\'")
        let javascript = """
        window.postMessage({type: 'native-image-selected', dataUrl: '\(escapedData)'}, '*');
        """
        
        webView?.evaluateJavaScript(javascript, completionHandler: nil)
    }
    
    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
        picker.dismiss(animated: true)
    }
}

class ClipboardBridge: NSObject, WKScriptMessageHandler {
    weak var webView: WKWebView?
    weak var imagePickerCoordinator: ImagePickerCoordinator?
    
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let action = body["action"] as? String else {
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
               let canRedo = body["canRedo"] as? Bool {
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
}

class BlockTypeInputView: UIView {
    var onSelect: ((String) -> Void)?
    private var keyboardHeightConstraint: NSLayoutConstraint?
    static var cachedKeyboardHeight: CGFloat = 291 // Default iPhone keyboard height
    
    override init(frame: CGRect) {
        super.init(frame: frame)
        setupUI()
    }
    
    required init?(coder: NSCoder) {
        super.init(coder: coder)
        setupUI()
    }
    
    override var intrinsicContentSize: CGSize {
        // Return the cached keyboard height
        CGSize(width: UIView.noIntrinsicMetric, height: Self.cachedKeyboardHeight)
    }
    
    func updateHeight(_ height: CGFloat) {
        keyboardHeightConstraint?.constant = height
        invalidateIntrinsicContentSize()
    }
    
    private func setupUI() {
        // self.backgroundColor = .secondarySystemGroupedBackground
        self.autoresizingMask = [.flexibleHeight]
        
        // Container for content
        let container = UIView()
        container.translatesAutoresizingMaskIntoConstraints = false
        addSubview(container)
        
        // Header label
        let headerLabel = UILabel()
        headerLabel.text = "Turn into"
        headerLabel.font = UIFont.systemFont(ofSize: 16, weight: .medium)
        headerLabel.textColor = .label
        headerLabel.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(headerLabel)
        
        // ScrollView for grid
        let scrollView = UIScrollView()
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        scrollView.showsVerticalScrollIndicator = true
        container.addSubview(scrollView)
        
        // Grid container
        let gridContainer = UIView()
        gridContainer.translatesAutoresizingMaskIntoConstraints = false
        scrollView.addSubview(gridContainer)
        
        // Create buttons in grid layout (2 columns)
        let types = [
            ("Paragraph", "paragraph", "text"),
            ("Heading 1", "heading1", "heading1"),
            ("Heading 2", "heading2", "heading2"),
            ("Heading 3", "heading3", "heading3"),
            ("Numbered List", "numberedList", "list_ordered"),
            ("Task List", "taskList", "list_todo"),
            ("Bulleted List", "bulletedList", "list"),
            ("Image", "image", "image")
        ]
        
        var buttons: [UIButton] = []
        for (title, value, iconName) in types {
            let button = UIButton(type: .system)
            button.setTitle(title, for: .normal)
            button.backgroundColor = .tertiarySystemGroupedBackground
            button.layer.cornerRadius = 8
            button.setTitleColor(.label, for: .normal)
            button.contentHorizontalAlignment = .left
            button.titleLabel?.font = UIFont.systemFont(ofSize: 15)
            button.translatesAutoresizingMaskIntoConstraints = false
            
            // Add icon to button
            if let iconImage = UIImage(named: iconName) {
                button.setImage(iconImage.withRenderingMode(.alwaysTemplate), for: .normal)
                button.tintColor = .label
                button.imageEdgeInsets = UIEdgeInsets(top: 0, left: 0, bottom: 0, right: 12)
                button.titleEdgeInsets = UIEdgeInsets(top: 0, left: 12, bottom: 0, right: 0)
                button.contentEdgeInsets = UIEdgeInsets(top: 0, left: 16, bottom: 0, right: 16)
            } else {
                button.contentEdgeInsets = UIEdgeInsets(top: 0, left: 16, bottom: 0, right: 16)
            }
            
            let action = UIAction { [weak self] _ in
                self?.onSelect?(value)
            }
            button.addAction(action, for: .touchUpInside)
            
            gridContainer.addSubview(button)
            buttons.append(button)
        }
        
        // Height constraint that will match keyboard height
        keyboardHeightConstraint = heightAnchor.constraint(equalToConstant: Self.cachedKeyboardHeight)
        keyboardHeightConstraint?.isActive = true
        
        // Layout constraints
        NSLayoutConstraint.activate([
            // Container fills the view
            container.topAnchor.constraint(equalTo: topAnchor),
            container.leadingAnchor.constraint(equalTo: leadingAnchor),
            container.trailingAnchor.constraint(equalTo: trailingAnchor),
            container.bottomAnchor.constraint(equalTo: bottomAnchor),
            
            // Header
            headerLabel.topAnchor.constraint(equalTo: container.topAnchor, constant: 16),
            headerLabel.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 20),
            headerLabel.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -20),
            
            // ScrollView
            scrollView.topAnchor.constraint(equalTo: headerLabel.bottomAnchor, constant: 12),
            scrollView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            scrollView.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -16),
            
            // Grid container in ScrollView
            gridContainer.topAnchor.constraint(equalTo: scrollView.topAnchor),
            gridContainer.leadingAnchor.constraint(equalTo: scrollView.leadingAnchor, constant: 16),
            gridContainer.trailingAnchor.constraint(equalTo: scrollView.trailingAnchor, constant: -16),
            gridContainer.bottomAnchor.constraint(equalTo: scrollView.bottomAnchor),
            gridContainer.widthAnchor.constraint(equalTo: scrollView.widthAnchor, constant: -32)
        ])
        
        // Grid layout (2 columns, 4 rows)
        // Row 1: Paragraph (left), Heading 1 (right)
        NSLayoutConstraint.activate([
            buttons[0].topAnchor.constraint(equalTo: gridContainer.topAnchor),
            buttons[0].leadingAnchor.constraint(equalTo: gridContainer.leadingAnchor),
            buttons[0].heightAnchor.constraint(equalToConstant: 60),
            buttons[0].widthAnchor.constraint(equalTo: gridContainer.widthAnchor, multiplier: 0.5, constant: -4),
            
            buttons[1].topAnchor.constraint(equalTo: gridContainer.topAnchor),
            buttons[1].trailingAnchor.constraint(equalTo: gridContainer.trailingAnchor),
            buttons[1].heightAnchor.constraint(equalToConstant: 60),
            buttons[1].widthAnchor.constraint(equalTo: gridContainer.widthAnchor, multiplier: 0.5, constant: -4),
            
            // Row 2: Heading 2 (left), Heading 3 (right)
            buttons[2].topAnchor.constraint(equalTo: buttons[0].bottomAnchor, constant: 8),
            buttons[2].leadingAnchor.constraint(equalTo: gridContainer.leadingAnchor),
            buttons[2].heightAnchor.constraint(equalToConstant: 60),
            buttons[2].widthAnchor.constraint(equalTo: gridContainer.widthAnchor, multiplier: 0.5, constant: -4),
            
            buttons[3].topAnchor.constraint(equalTo: buttons[1].bottomAnchor, constant: 8),
            buttons[3].trailingAnchor.constraint(equalTo: gridContainer.trailingAnchor),
            buttons[3].heightAnchor.constraint(equalToConstant: 60),
            buttons[3].widthAnchor.constraint(equalTo: gridContainer.widthAnchor, multiplier: 0.5, constant: -4),
            
            // Row 3: Numbered List (left), Task List (right)
            buttons[4].topAnchor.constraint(equalTo: buttons[2].bottomAnchor, constant: 8),
            buttons[4].leadingAnchor.constraint(equalTo: gridContainer.leadingAnchor),
            buttons[4].heightAnchor.constraint(equalToConstant: 60),
            buttons[4].widthAnchor.constraint(equalTo: gridContainer.widthAnchor, multiplier: 0.5, constant: -4),
            
            buttons[5].topAnchor.constraint(equalTo: buttons[3].bottomAnchor, constant: 8),
            buttons[5].trailingAnchor.constraint(equalTo: gridContainer.trailingAnchor),
            buttons[5].heightAnchor.constraint(equalToConstant: 60),
            buttons[5].widthAnchor.constraint(equalTo: gridContainer.widthAnchor, multiplier: 0.5, constant: -4),
            
            // Row 4: Bulleted List (left), Image (right)
            buttons[6].topAnchor.constraint(equalTo: buttons[4].bottomAnchor, constant: 8),
            buttons[6].leadingAnchor.constraint(equalTo: gridContainer.leadingAnchor),
            buttons[6].heightAnchor.constraint(equalToConstant: 60),
            buttons[6].widthAnchor.constraint(equalTo: gridContainer.widthAnchor, multiplier: 0.5, constant: -4),
            
            buttons[7].topAnchor.constraint(equalTo: buttons[5].bottomAnchor, constant: 8),
            buttons[7].trailingAnchor.constraint(equalTo: gridContainer.trailingAnchor),
            buttons[7].heightAnchor.constraint(equalToConstant: 60),
            buttons[7].widthAnchor.constraint(equalTo: gridContainer.widthAnchor, multiplier: 0.5, constant: -4),
            
            // Bottom constraint for grid container
            buttons[6].bottomAnchor.constraint(lessThanOrEqualTo: gridContainer.bottomAnchor),
            buttons[7].bottomAnchor.constraint(lessThanOrEqualTo: gridContainer.bottomAnchor)
        ])
    }
}

class AccessoryIslandView: UIView {
    var onUndo: (() -> Void)?
    var onRedo: (() -> Void)?
    var onFormat: (() -> Void)?
    var onDismiss: (() -> Void)?
    
    private let undoBtn = UIButton(type: .system)
    private let redoBtn = UIButton(type: .system)
    private let formatBtn = UIButton(type: .system)
    private let dismissBtn = UIButton(type: .system)
    
    var currentIconType: String = "format"
    
    override init(frame: CGRect) {
        super.init(frame: frame)
        setupUI()
    }
    
    required init?(coder: NSCoder) {
        super.init(coder: coder)
        setupUI()
    }
    
    private func setupUI() {
        backgroundColor = .clear
        autoresizingMask = [.flexibleHeight]
        
        // Main container (The Island)
        let container = UIView()
        container.backgroundColor = .secondarySystemGroupedBackground
        container.layer.cornerRadius = 22 // Capsule shape for 44pt height
        container.layer.shadowColor = UIColor.black.cgColor
        container.layer.shadowOpacity = 0.1
        container.layer.shadowOffset = CGSize(width: 0, height: 4)
        container.layer.shadowRadius = 8
        container.translatesAutoresizingMaskIntoConstraints = false
        
        addSubview(container)
        
        // StackView
        let stack = UIStackView(arrangedSubviews: [undoBtn, redoBtn, formatBtn, dismissBtn])
        stack.axis = .horizontal
        stack.distribution = .fillEqually
        stack.alignment = .center
        stack.spacing = 2
        stack.translatesAutoresizingMaskIntoConstraints = false
        
        container.addSubview(stack)
        
        NSLayoutConstraint.activate([
            // Container centered with padding
            container.centerXAnchor.constraint(equalTo: centerXAnchor),
            container.topAnchor.constraint(equalTo: topAnchor, constant: 6),
            container.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -6),
            container.heightAnchor.constraint(equalToConstant: 44),
            
            // Flexible width with margins
            container.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16),
            container.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16),
            
            // Stack inside container
            stack.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 8),
            stack.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -8),
            stack.topAnchor.constraint(equalTo: container.topAnchor),
            stack.bottomAnchor.constraint(equalTo: container.bottomAnchor)
        ])
        
        // Setup buttons with custom icons
        configureButtonWithImage(undoBtn, imageName: "undo")
        configureButtonWithImage(redoBtn, imageName: "redo")
        configureButtonWithImage(formatBtn, imageName: "format_text")
        configureButtonWithImage(dismissBtn, imageName: "keyboard_dismiss")
        
        undoBtn.addTarget(self, action: #selector(undoTapped), for: .touchUpInside)
        redoBtn.addTarget(self, action: #selector(redoTapped), for: .touchUpInside)
        formatBtn.addTarget(self, action: #selector(formatTapped), for: .touchUpInside)
        dismissBtn.addTarget(self, action: #selector(dismissTapped), for: .touchUpInside)
    }
    
    private func configureButtonWithImage(_ button: UIButton, imageName: String) {
        if let image = UIImage(named: imageName) {
            button.setImage(image.withRenderingMode(.alwaysTemplate), for: .normal)
        }
        button.tintColor = .label
    }
    
    @objc private func undoTapped() { onUndo?() }
    @objc private func redoTapped() { onRedo?() }
    @objc private func formatTapped() { onFormat?() }
    @objc private func dismissTapped() { onDismiss?() }
    
    func updateState(canUndo: Bool, canRedo: Bool, isMenuOpen: Bool) {
        undoBtn.isEnabled = canUndo
        redoBtn.isEnabled = canRedo
        undoBtn.alpha = canUndo ? 1.0 : 0.3
        redoBtn.alpha = canRedo ? 1.0 : 0.3
        
        // Highlight format button with tint color when menu is open
        formatBtn.tintColor = isMenuOpen ? .systemGreen : .label
        
        let dismissImageName = isMenuOpen ? "xmark" : "keyboard_dismiss"
        if dismissImageName == "xmark" {
            let config = UIImage.SymbolConfiguration(scale: .medium)
            dismissBtn.setImage(UIImage(systemName: "xmark", withConfiguration: config), for: .normal)
        } else if let image = UIImage(named: "keyboard_dismiss") {
            dismissBtn.setImage(image.withRenderingMode(.alwaysTemplate), for: .normal)
        }
    }
    
    func updateIcon(iconType: String) {
        currentIconType = iconType
        
        // Hide format button when iconType is "none"
        if iconType == "none" {
            formatBtn.isHidden = true
            return
        }
        
        formatBtn.isHidden = false
        let imageName: String
        switch iconType {
        case "link":
            imageName = "link"
        case "image":
            imageName = "image"
        default:
            imageName = "format_text"
        }
        
        if let image = UIImage(named: imageName) {
            formatBtn.setImage(image.withRenderingMode(.alwaysTemplate), for: .normal)
        }
    }
}

class CustomWebView: WKWebView {
    private var islandView: AccessoryIslandView?
    private let dummyTextField = UITextField()
    private var blockTypeInputView: BlockTypeInputView?
    
    // State
    private var canUndo = false
    private var canRedo = false
    private var isMenuOpen = false
    private var isEditorFocused = false  // Track if canvas editor is focused
    private var lastKeyboardHeight: CGFloat = 291 // Track the last keyboard height
    var currentIconType: String = "format"  // Track current icon type
    private var hasPhysicalKeyboard = false // Track hardware keyboard status
    
    override var inputAccessoryView: UIView? {
        // Hide keyboard island when physical keyboard is connected
        // Only show when canvas editor is focused AND no physical keyboard
        return (isEditorFocused && !hasPhysicalKeyboard) ? islandView : nil
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
            selector: #selector(keyboardWillHide(_:)),
            name: UIResponder.keyboardWillHideNotification,
            object: nil
        )
        
        // Observe hardware keyboard connection changes (iOS 14+)
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
        if let keyboardFrame = notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect {
            // Only update if this is the system keyboard (not our custom inputView)
            // Our custom inputView won't have a consistent height initially
            // System keyboard + accessory is typically 300-350+ on iPhone
            if !isMenuOpen && keyboardFrame.height > 200 {
                // The keyboard frame includes the accessory view + safe area insets
                // Accessory view: 56pt (44pt container + 6pt top + 6pt bottom)
                // Plus safe area bottom inset (usually ~34pt on iPhones with notch, 0 on others)
                let accessoryWithSafeArea = islandView?.frame.height ?? 56
                let keyboardOnlyHeight = keyboardFrame.height - accessoryWithSafeArea
                
                // Update cached height and the input view
                lastKeyboardHeight = keyboardOnlyHeight
                BlockTypeInputView.cachedKeyboardHeight = keyboardOnlyHeight
                blockTypeInputView?.updateHeight(keyboardOnlyHeight)
            }
        }
    }
    
    @objc private func keyboardWillHide(_ notification: Notification) {
        // Re-detect physical keyboard status when keyboard hides
        // This helps catch hardware keyboard connect/disconnect events
        detectPhysicalKeyboard()
    }
    
    @available(iOS 14.0, *)
    @objc private func keyboardDidConnect(_ notification: Notification) {
        hasPhysicalKeyboard = true
        notifyPhysicalKeyboardState()
        reloadInputViews()
    }
    
    @available(iOS 14.0, *)
    @objc private func keyboardDidDisconnect(_ notification: Notification) {
        // Check if any keyboards are still connected
        if #available(iOS 14.0, *) {
            hasPhysicalKeyboard = GCKeyboard.coalesced != nil
        } else {
            hasPhysicalKeyboard = false
        }
        notifyPhysicalKeyboardState()
        reloadInputViews()
    }
    
    private func detectPhysicalKeyboard() {
        // On iOS, we can detect hardware keyboard by checking if there are any connected hardware keyboards
        // UITextInputMode.activeInputModes shows available keyboards
        // If only hardware keyboards are available, the software keyboard won't show
        
        // Method 1: Check if keyboard wants autocorrection (hardware keyboards typically don't)
        // This is a heuristic - not perfect but works in most cases
        let inputDelegate = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }
            .first { $0.isKeyWindow }?
            .rootViewController
        
        // Method 2: Check keyboard frame - if keyboard shows with 0 or minimal height, it's hardware
        // This is checked in keyboardWillShow, but for initial state we use heuristics
        
        // For initial detection, we check if device is iPad (more likely to have keyboard)
        // and if we're in landscape (keyboards often used in landscape)
        let isIPad = UIDevice.current.userInterfaceIdiom == .pad
        let hasExternalKeyboard = GCKeyboard.coalesced != nil // Check for connected keyboard via GameController
        
        let previousState = hasPhysicalKeyboard
        hasPhysicalKeyboard = isIPad && hasExternalKeyboard
        
        // Notify WebView if state changed
        if previousState != hasPhysicalKeyboard {
            notifyPhysicalKeyboardState()
            reloadInputViews() // Update accessory view visibility
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
        
        self.islandView = island
        self.dummyTextField.inputAccessoryView = island
        
        self.reloadInputViews()
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
            // Reload input views to update the accessory view visibility
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

    @objc func onUndo() {
        self.evaluateJavaScript("if(window.IOSBridge && window.IOSBridge.undo) window.IOSBridge.undo()", completionHandler: nil)
    }

    @objc func onRedo() {
        self.evaluateJavaScript("if(window.IOSBridge && window.IOSBridge.redo) window.IOSBridge.redo()", completionHandler: nil)
    }

    @objc func onFormat() {
        if isMenuOpen {
            // Close the block menu
            isMenuOpen = false
            dummyTextField.resignFirstResponder()
            self.evaluateJavaScript("if(window.IOSBridge && window.IOSBridge.focus) window.IOSBridge.focus()", completionHandler: nil)
            updateToolbarState()
        } else {
            // Try to let web handle it first (for link/image drawers)
            self.evaluateJavaScript("(function() { if(window.IOSBridge && window.IOSBridge.onFormatButtonClick) { return window.IOSBridge.onFormatButtonClick(); } return false; })()", completionHandler: { result, error in
                if let handled = result as? Bool, handled {
                    // Web handled it (opened a drawer)
                    return
                } else {
                    // Web didn't handle it, open block menu
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
            // Close menu, go back to keyboard
            isMenuOpen = false
            dummyTextField.resignFirstResponder()
            self.evaluateJavaScript("if(window.IOSBridge && window.IOSBridge.focus) window.IOSBridge.focus()", completionHandler: nil)
        } else {
            // Dismiss keyboard
            self.endEditing(true)
        }
        updateToolbarState()
    }
    
    func applyBlockType(_ type: String) {
        let js = "if(window.IOSBridge && window.IOSBridge.setBlockType) window.IOSBridge.setBlockType('\(type)')"
        evaluateJavaScript(js, completionHandler: nil)
        
        // Dismiss menu after selection and return to keyboard
        isMenuOpen = false
        dummyTextField.resignFirstResponder()
        self.evaluateJavaScript("if(window.IOSBridge && window.IOSBridge.focus) window.IOSBridge.focus()", completionHandler: nil)
        
        updateToolbarState()
    }
}

struct WebView: UIViewRepresentable {
    let url: URL
    @Binding var isLoading: Bool
    @Environment(\.colorScheme) var colorScheme
    
    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }
    
    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        let userContentController = WKUserContentController()
        
        // Create and store bridges in coordinator to keep them alive
        let clipboardBridge = ClipboardBridge()
        let imagePickerCoordinator = ImagePickerCoordinator()
        clipboardBridge.imagePickerCoordinator = imagePickerCoordinator
        
        // Store in coordinator
        context.coordinator.clipboardBridge = clipboardBridge
        context.coordinator.imagePickerCoordinator = imagePickerCoordinator
        
        userContentController.add(clipboardBridge, name: "IOSBridge")
        
        // Inject alias for IOSBridge as a wrapper object to allow extension
        let scriptSource = """
        window.IOSBridge = {
            postMessage: function(msg) { window.webkit.messageHandlers.IOSBridge.postMessage(msg); },
            setEditorFocused: function(focused) { 
                window.webkit.messageHandlers.IOSBridge.postMessage({action: 'editor-focus', focused: focused}); 
            }
        };
        """
        let script = WKUserScript(source: scriptSource, injectionTime: .atDocumentStart, forMainFrameOnly: false)
        userContentController.addUserScript(script)
        
        configuration.userContentController = userContentController
        
        let webView = CustomWebView(frame: .zero, configuration: configuration)
        webView.setupAccessoryView()
        
        // Set WebView background to theme color to prevent white flash
        webView.isOpaque = false
        if let backgroundColor = UIColor(named: "Background") {
            webView.backgroundColor = backgroundColor
            webView.scrollView.backgroundColor = backgroundColor
            
            // Inject the background color into the web content
            let backgroundColorHex = backgroundColor.toHex()
            let themeScript = """
            document.documentElement.style.backgroundColor = '\(backgroundColorHex)';
            if (document.body) {
                document.body.style.backgroundColor = '\(backgroundColorHex)';
            } else {
                document.addEventListener('DOMContentLoaded', function() {
                    document.body.style.backgroundColor = '\(backgroundColorHex)';
                });
            }
            """
            webView.evaluateJavaScript(themeScript, completionHandler: nil)
        }
        
        webView.navigationDelegate = context.coordinator
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.showsVerticalScrollIndicator = false
        webView.scrollView.showsHorizontalScrollIndicator = false
        webView.scrollView.bounces = false
        
        clipboardBridge.webView = webView
        imagePickerCoordinator.webView = webView
        
        // Delay setting the presenting view controller to ensure the view hierarchy is ready
        DispatchQueue.main.async {
            if let windowScene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
               let rootViewController = windowScene.windows.first?.rootViewController {
                context.coordinator.imagePickerCoordinator?.presentingViewController = rootViewController
            }
        }
        
        let preferences = WKWebpagePreferences()
        preferences.allowsContentJavaScript = true
        webView.configuration.defaultWebpagePreferences = preferences
        // Removed deprecated: webView.configuration.preferences.javaScriptEnabled = true
        
        webView.allowsBackForwardNavigationGestures = true
        
        // Enable Web Inspector for localhost/debug builds only
        #if DEBUG
        if #available(iOS 16.4, *) {
            webView.isInspectable = true
        }
        #endif
        
        NotificationCenter.default.addObserver(
            forName: UIResponder.keyboardWillShowNotification,
            object: nil,
            queue: .main
        ) { notification in
            if let keyboardFrame = notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect {
                let keyboardHeight = keyboardFrame.height
                let js = "window.postMessage({type: 'keyboard-show', height: \(keyboardHeight)}, '*');"
                webView.evaluateJavaScript(js, completionHandler: nil)
            }
        }
        
        NotificationCenter.default.addObserver(
            forName: UIResponder.keyboardWillHideNotification,
            object: nil,
            queue: .main
        ) { _ in
            let js = "window.postMessage({type: 'keyboard-hide'}, '*');"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }
        
        return webView
    }
    
    func updateUIView(_ webView: WKWebView, context: Context) {
        // Update background color when color scheme changes
        if let backgroundColor = UIColor(named: "Background") {
            webView.backgroundColor = backgroundColor
            webView.scrollView.backgroundColor = backgroundColor
            
            // Update the web content background color
            let backgroundColorHex = backgroundColor.toHex()
            let themeScript = """
            document.documentElement.style.backgroundColor = '\(backgroundColorHex)';
            if (document.body) {
                document.body.style.backgroundColor = '\(backgroundColorHex)';
            }
            """
            webView.evaluateJavaScript(themeScript, completionHandler: nil)
        }
        
        if webView.url == nil {
            let request = URLRequest(url: url)
            webView.load(request)
        }
    }
    
    class Coordinator: NSObject, WKNavigationDelegate {
        var parent: WebView
        var clipboardBridge: ClipboardBridge?
        var imagePickerCoordinator: ImagePickerCoordinator?
        
        init(_ parent: WebView) {
            self.parent = parent
        }
        
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            withAnimation {
                parent.isLoading = false
            }
            
            // Send initial physical keyboard state to web after page loads
            if let customWebView = webView as? CustomWebView {
                customWebView.notifyPhysicalKeyboardState()
            }
        }
        
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            withAnimation {
                parent.isLoading = false
            }
        }
        
        func webView(_ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
            // Trust localhost SSL certificates for development
            if  challenge.protectionSpace.host.starts(with: "192.168.") ||
                challenge.protectionSpace.host == "localhost" ||
               challenge.protectionSpace.host == "127.0.0.1" {
                if let serverTrust = challenge.protectionSpace.serverTrust {
                    let credential = URLCredential(trust: serverTrust)
                    completionHandler(.useCredential, credential)
                    return
                }
            }
            
            // For other hosts, use default handling
            completionHandler(.performDefaultHandling, nil)
        }
    }
}

struct LoadingView: View {
    @State private var rotation: Double = 0
    
    var body: some View {
        Color("Background")
            .edgesIgnoringSafeArea(.all)
            .overlay(
                Image("spinner")
                    .resizable()
                    .frame(width: 32, height: 32)
                    .rotationEffect(.degrees(rotation))
                    .onAppear {
                        withAnimation(.linear(duration: 1.0).repeatForever(autoreverses: false)) {
                            rotation = 360
                        }
                    }
            )
    }
}

#Preview {
    ContentView()
}
