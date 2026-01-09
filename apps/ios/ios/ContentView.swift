//
//  ContentView.swift
//  ios
//
//  Created by Hamza Khuswan on 2025-12-28.
//

import GameController
import SwiftUI
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

class ImagePickerCoordinator: NSObject, UINavigationControllerDelegate,
    UIImagePickerControllerDelegate
{
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

    func imagePickerController(
        _ picker: UIImagePickerController,
        didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
    ) {
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

class BlockTypeInputView: UIView, UIInputViewAudioFeedback {
    var onSelect: ((String) -> Void)?
    private var keyboardHeightConstraint: NSLayoutConstraint?
    static var cachedKeyboardHeight: CGFloat = 291  // Default iPhone keyboard height

    // Required for UIInputViewAudioFeedback
    var enableInputClicksWhenVisible: Bool {
        return true
    }

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
            ("Numbered List", "numbered_list", "list_ordered"),
            ("Task List", "todo_list", "list_todo"),
            ("Bulleted List", "bullet_list", "list"),
            ("Image", "image", "image"),
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
        keyboardHeightConstraint = heightAnchor.constraint(
            equalToConstant: Self.cachedKeyboardHeight)
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
            gridContainer.trailingAnchor.constraint(
                equalTo: scrollView.trailingAnchor, constant: -16),
            gridContainer.bottomAnchor.constraint(equalTo: scrollView.bottomAnchor),
            gridContainer.widthAnchor.constraint(equalTo: scrollView.widthAnchor, constant: -32),
        ])

        // Grid layout (2 columns, 4 rows)
        // Row 1: Paragraph (left), Heading 1 (right)
        NSLayoutConstraint.activate([
            buttons[0].topAnchor.constraint(equalTo: gridContainer.topAnchor),
            buttons[0].leadingAnchor.constraint(equalTo: gridContainer.leadingAnchor),
            buttons[0].heightAnchor.constraint(equalToConstant: 60),
            buttons[0].widthAnchor.constraint(
                equalTo: gridContainer.widthAnchor, multiplier: 0.5, constant: -4),

            buttons[1].topAnchor.constraint(equalTo: gridContainer.topAnchor),
            buttons[1].trailingAnchor.constraint(equalTo: gridContainer.trailingAnchor),
            buttons[1].heightAnchor.constraint(equalToConstant: 60),
            buttons[1].widthAnchor.constraint(
                equalTo: gridContainer.widthAnchor, multiplier: 0.5, constant: -4),

            // Row 2: Heading 2 (left), Heading 3 (right)
            buttons[2].topAnchor.constraint(equalTo: buttons[0].bottomAnchor, constant: 8),
            buttons[2].leadingAnchor.constraint(equalTo: gridContainer.leadingAnchor),
            buttons[2].heightAnchor.constraint(equalToConstant: 60),
            buttons[2].widthAnchor.constraint(
                equalTo: gridContainer.widthAnchor, multiplier: 0.5, constant: -4),

            buttons[3].topAnchor.constraint(equalTo: buttons[1].bottomAnchor, constant: 8),
            buttons[3].trailingAnchor.constraint(equalTo: gridContainer.trailingAnchor),
            buttons[3].heightAnchor.constraint(equalToConstant: 60),
            buttons[3].widthAnchor.constraint(
                equalTo: gridContainer.widthAnchor, multiplier: 0.5, constant: -4),

            // Row 3: Numbered List (left), Task List (right)
            buttons[4].topAnchor.constraint(equalTo: buttons[2].bottomAnchor, constant: 8),
            buttons[4].leadingAnchor.constraint(equalTo: gridContainer.leadingAnchor),
            buttons[4].heightAnchor.constraint(equalToConstant: 60),
            buttons[4].widthAnchor.constraint(
                equalTo: gridContainer.widthAnchor, multiplier: 0.5, constant: -4),

            buttons[5].topAnchor.constraint(equalTo: buttons[3].bottomAnchor, constant: 8),
            buttons[5].trailingAnchor.constraint(equalTo: gridContainer.trailingAnchor),
            buttons[5].heightAnchor.constraint(equalToConstant: 60),
            buttons[5].widthAnchor.constraint(
                equalTo: gridContainer.widthAnchor, multiplier: 0.5, constant: -4),

            // Row 4: Bulleted List (left), Image (right)
            buttons[6].topAnchor.constraint(equalTo: buttons[4].bottomAnchor, constant: 8),
            buttons[6].leadingAnchor.constraint(equalTo: gridContainer.leadingAnchor),
            buttons[6].heightAnchor.constraint(equalToConstant: 60),
            buttons[6].widthAnchor.constraint(
                equalTo: gridContainer.widthAnchor, multiplier: 0.5, constant: -4),

            buttons[7].topAnchor.constraint(equalTo: buttons[5].bottomAnchor, constant: 8),
            buttons[7].trailingAnchor.constraint(equalTo: gridContainer.trailingAnchor),
            buttons[7].heightAnchor.constraint(equalToConstant: 60),
            buttons[7].widthAnchor.constraint(
                equalTo: gridContainer.widthAnchor, multiplier: 0.5, constant: -4),

            // Bottom constraint for grid container
            buttons[6].bottomAnchor.constraint(lessThanOrEqualTo: gridContainer.bottomAnchor),
            buttons[7].bottomAnchor.constraint(lessThanOrEqualTo: gridContainer.bottomAnchor),
        ])
    }
}

class AccessoryIslandView: UIView {
    var onUndo: (() -> Void)?
    var onRedo: (() -> Void)?
    var onFormat: (() -> Void)?
    var onDismiss: (() -> Void)?
    var onBlockType: (() -> Void)?
    var onBold: (() -> Void)?
    var onItalic: (() -> Void)?
    var onCode: (() -> Void)?
    var onStrikethrough: (() -> Void)?

    // Main toolbar buttons
    private let undoBtn = UIButton(type: .system)
    private let redoBtn = UIButton(type: .system)
    private let inlineFormatBtn = UIButton(type: .system)
    private let blockTypeBtn = UIButton(type: .system)
    private let dismissBtn = UIButton(type: .system)

    // Formatting buttons
    private let boldBtn = UIButton(type: .system)
    private let italicBtn = UIButton(type: .system)
    private let codeBtn = UIButton(type: .system)
    private let strikethroughBtn = UIButton(type: .system)
    private let closeFormatBtn = UIButton(type: .system)

    // Container views
    private var container: UIView!
    private var scrollView: UIScrollView!
    private var mainButtonsStack: UIStackView!
    private var formattingButtonsStack: UIStackView!
    private var dividerView: UIView!

    private var isFormattingExpanded = false

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
        autoresizingMask = [.flexibleWidth, .flexibleHeight]

        // Main container - full width floating island
        container = UIView()
        container.backgroundColor = .secondarySystemGroupedBackground
        container.layer.cornerRadius = 22
        container.layer.shadowColor = UIColor.black.cgColor
        container.layer.shadowOpacity = 0.1
        container.layer.shadowOffset = CGSize(width: 0, height: 4)
        container.layer.shadowRadius = 8
        container.translatesAutoresizingMaskIntoConstraints = false
        addSubview(container)

        // ScrollView for buttons on the left
        scrollView = UIScrollView()
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        scrollView.showsHorizontalScrollIndicator = false
        scrollView.showsVerticalScrollIndicator = false
        scrollView.alwaysBounceHorizontal = true
        container.addSubview(scrollView)

        // Main buttons stack (undo, redo, format, block type)
        mainButtonsStack = UIStackView(arrangedSubviews: [
            undoBtn, redoBtn, inlineFormatBtn, blockTypeBtn,
        ])
        mainButtonsStack.axis = .horizontal
        mainButtonsStack.distribution = .fill
        mainButtonsStack.alignment = .center
        mainButtonsStack.spacing = 2
        mainButtonsStack.translatesAutoresizingMaskIntoConstraints = false
        scrollView.addSubview(mainButtonsStack)

        // Formatting buttons stack (bold, italic, code, strikethrough, close)
        formattingButtonsStack = UIStackView(arrangedSubviews: [
            closeFormatBtn, boldBtn, italicBtn, codeBtn, strikethroughBtn,
        ])
        formattingButtonsStack.axis = .horizontal
        formattingButtonsStack.distribution = .fill
        formattingButtonsStack.alignment = .center
        formattingButtonsStack.spacing = 2
        formattingButtonsStack.translatesAutoresizingMaskIntoConstraints = false
        formattingButtonsStack.isHidden = true
        scrollView.addSubview(formattingButtonsStack)

        // Divider between scroll area and dismiss button
        dividerView = UIView()
        dividerView.backgroundColor = .separator
        dividerView.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(dividerView)

        // Dismiss button (always visible on right)
        dismissBtn.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(dismissBtn)

        // Set up button sizes
        let buttonWidth: CGFloat = 44
        let buttonHeight: CGFloat = 44

        // Configure all buttons
        for button in [
            undoBtn, redoBtn, inlineFormatBtn, blockTypeBtn, dismissBtn, boldBtn, italicBtn,
            codeBtn, strikethroughBtn, closeFormatBtn,
        ] {
            NSLayoutConstraint.activate([
                button.widthAnchor.constraint(equalToConstant: buttonWidth),
                button.heightAnchor.constraint(equalToConstant: buttonHeight),
            ])
        }

        NSLayoutConstraint.activate([
            // Container spans full width with padding (floating island style)
            container.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            container.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            container.topAnchor.constraint(equalTo: topAnchor, constant: 6),
            container.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -6),
            container.heightAnchor.constraint(equalToConstant: 44),

            // Dismiss button on the right
            dismissBtn.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -4),
            dismissBtn.centerYAnchor.constraint(equalTo: container.centerYAnchor),

            // Divider to the left of dismiss button
            dividerView.trailingAnchor.constraint(equalTo: dismissBtn.leadingAnchor, constant: -4),
            dividerView.centerYAnchor.constraint(equalTo: container.centerYAnchor),
            dividerView.widthAnchor.constraint(equalToConstant: 1),
            dividerView.heightAnchor.constraint(equalToConstant: 28),

            // ScrollView takes the remaining space
            scrollView.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 4),
            scrollView.trailingAnchor.constraint(equalTo: dividerView.leadingAnchor, constant: -4),
            scrollView.topAnchor.constraint(equalTo: container.topAnchor),
            scrollView.bottomAnchor.constraint(equalTo: container.bottomAnchor),

            // Main buttons stack inside scroll view
            mainButtonsStack.leadingAnchor.constraint(
                equalTo: scrollView.contentLayoutGuide.leadingAnchor),
            mainButtonsStack.trailingAnchor.constraint(
                equalTo: scrollView.contentLayoutGuide.trailingAnchor),
            mainButtonsStack.topAnchor.constraint(equalTo: scrollView.contentLayoutGuide.topAnchor),
            mainButtonsStack.bottomAnchor.constraint(
                equalTo: scrollView.contentLayoutGuide.bottomAnchor),
            mainButtonsStack.heightAnchor.constraint(
                equalTo: scrollView.frameLayoutGuide.heightAnchor),

            // Formatting buttons stack inside scroll view (no trailing constraint - let it size naturally)
            formattingButtonsStack.leadingAnchor.constraint(
                equalTo: scrollView.contentLayoutGuide.leadingAnchor),
            formattingButtonsStack.topAnchor.constraint(
                equalTo: scrollView.contentLayoutGuide.topAnchor),
            formattingButtonsStack.bottomAnchor.constraint(
                equalTo: scrollView.contentLayoutGuide.bottomAnchor),
            formattingButtonsStack.heightAnchor.constraint(
                equalTo: scrollView.frameLayoutGuide.heightAnchor),
        ])

        // Setup buttons with custom icons
        configureButtonWithImage(undoBtn, imageName: "undo")
        configureButtonWithImage(redoBtn, imageName: "redo")
        configureButtonWithImage(inlineFormatBtn, imageName: "format_text")
        configureButtonWithImage(blockTypeBtn, imageName: "paragraph")
        configureButtonWithImage(dismissBtn, imageName: "keyboard_dismiss")

        // Setup formatting buttons
        configureButtonWithImage(boldBtn, imageName: "bold")
        configureButtonWithImage(italicBtn, imageName: "italic")
        configureButtonWithImage(codeBtn, imageName: "code")
        configureButtonWithImage(strikethroughBtn, imageName: "strikethrough")

        // Setup close format button with system icon (chevron left)
        let closeConfig = UIImage.SymbolConfiguration(scale: .medium)
        closeFormatBtn.setImage(
            UIImage(systemName: "chevron.left", withConfiguration: closeConfig), for: .normal)
        closeFormatBtn.tintColor = .label

        // Add button actions
        undoBtn.addTarget(self, action: #selector(undoTapped), for: .touchUpInside)
        redoBtn.addTarget(self, action: #selector(redoTapped), for: .touchUpInside)
        inlineFormatBtn.addTarget(self, action: #selector(inlineFormatTapped), for: .touchUpInside)
        blockTypeBtn.addTarget(self, action: #selector(blockTypeTapped), for: .touchUpInside)
        dismissBtn.addTarget(self, action: #selector(dismissTapped), for: .touchUpInside)

        boldBtn.addTarget(self, action: #selector(boldTapped), for: .touchUpInside)
        italicBtn.addTarget(self, action: #selector(italicTapped), for: .touchUpInside)
        codeBtn.addTarget(self, action: #selector(codeTapped), for: .touchUpInside)
        strikethroughBtn.addTarget(
            self, action: #selector(strikethroughTapped), for: .touchUpInside)
        closeFormatBtn.addTarget(self, action: #selector(closeFormatTapped), for: .touchUpInside)
    }

    private func configureButtonWithImage(_ button: UIButton, imageName: String) {
        if let image = UIImage(named: imageName) {
            button.setImage(image.withRenderingMode(.alwaysTemplate), for: .normal)
        }
        button.tintColor = .label
    }

    func toggleFormattingExpansion() {
        isFormattingExpanded.toggle()

        if isFormattingExpanded {
            // Prepare formatting buttons for animation (start invisible)
            formattingButtonsStack.alpha = 0
            formattingButtonsStack.isHidden = false

            UIView.animate(withDuration: 0.2, delay: 0, options: .curveEaseInOut) {
                // Fade out main buttons
                self.mainButtonsStack.alpha = 0
                // Fade in formatting buttons
                self.formattingButtonsStack.alpha = 1
            } completion: { _ in
                self.mainButtonsStack.isHidden = true
            }
        } else {
            // Prepare main buttons for animation (start invisible)
            mainButtonsStack.alpha = 0
            mainButtonsStack.isHidden = false

            UIView.animate(withDuration: 0.2, delay: 0, options: .curveEaseInOut) {
                // Fade out formatting buttons
                self.formattingButtonsStack.alpha = 0
                // Fade in main buttons
                self.mainButtonsStack.alpha = 1
            } completion: { _ in
                self.formattingButtonsStack.isHidden = true
            }
        }

        // Reset scroll position when toggling
        scrollView.setContentOffset(.zero, animated: true)
    }

    @objc private func undoTapped() { onUndo?() }
    @objc private func redoTapped() { onRedo?() }
    @objc private func inlineFormatTapped() { toggleFormattingExpansion() }
    @objc private func blockTypeTapped() { onBlockType?() }
    @objc private func dismissTapped() { onDismiss?() }

    @objc private func boldTapped() { onBold?() }
    @objc private func italicTapped() { onItalic?() }
    @objc private func codeTapped() { onCode?() }
    @objc private func strikethroughTapped() { onStrikethrough?() }
    @objc private func closeFormatTapped() { toggleFormattingExpansion() }

    func updateState(canUndo: Bool, canRedo: Bool, isMenuOpen: Bool) {
        undoBtn.isEnabled = canUndo
        redoBtn.isEnabled = canRedo
        undoBtn.alpha = canUndo ? 1.0 : 0.3
        redoBtn.alpha = canRedo ? 1.0 : 0.3

        // Highlight block type button with tint color when menu is open
        blockTypeBtn.tintColor = isMenuOpen ? .systemGreen : .label

        let dismissImageName = isMenuOpen ? "xmark" : "keyboard_dismiss"
        if dismissImageName == "xmark" {
            let config = UIImage.SymbolConfiguration(scale: .medium)
            dismissBtn.setImage(
                UIImage(systemName: "xmark", withConfiguration: config), for: .normal)
        } else if let image = UIImage(named: "keyboard_dismiss") {
            dismissBtn.setImage(image.withRenderingMode(.alwaysTemplate), for: .normal)
        }
    }

    func updateIcon(iconType: String) {
        currentIconType = iconType

        // Hide inline format button when iconType is "none"
        if iconType == "none" {
            blockTypeBtn.isHidden = true
            return
        }

        blockTypeBtn.isHidden = false
        let imageName: String
        switch iconType {
        case "link":
            imageName = "link"
        case "image":
            imageName = "image"
        default:
            imageName = "paragraph"
        }

        if let image = UIImage(named: imageName) {
            blockTypeBtn.setImage(image.withRenderingMode(.alwaysTemplate), for: .normal)
        }
    }

    func updateFormattingState(isBold: Bool, isItalic: Bool, isCode: Bool, isStrikethrough: Bool) {
        boldBtn.tintColor = isBold ? .systemGreen : .label
        italicBtn.tintColor = isItalic ? .systemGreen : .label
        codeBtn.tintColor = isCode ? .systemGreen : .label
        strikethroughBtn.tintColor = isStrikethrough ? .systemGreen : .label

        // Update inline format button to show active if any format is active
        let anyFormatActive = isBold || isItalic || isCode || isStrikethrough
        inlineFormatBtn.tintColor = anyFormatActive ? .systemGreen : .label
    }

    // Collapse formatting if expanded (useful when keyboard dismisses)
    func collapseFormattingIfNeeded() {
        if isFormattingExpanded {
            isFormattingExpanded = false
            // Reset alpha values and visibility without animation
            mainButtonsStack.alpha = 1
            mainButtonsStack.isHidden = false
            formattingButtonsStack.alpha = 0
            formattingButtonsStack.isHidden = true
            scrollView.setContentOffset(.zero, animated: false)
        }
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

    // Additional override to ensure the shortcuts bar is hidden
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
    private var isEditorFocused = false  // Track if canvas editor is focused
    private var lastKeyboardHeight: CGFloat = 291  // Track the last keyboard height
    var currentIconType: String = "format"  // Track current icon type
    private var hasPhysicalKeyboard = false  // Track hardware keyboard status
    private var isSoftKeyboardVisible = false  // Track if soft keyboard is actually visible

    override var inputAccessoryView: UIView? {
        // Only return island view when editor is focused
        // This prevents the toolbar from appearing on other inputs (like drawers)
        // print("🏝️ [inputAccessoryView] Called - isEditorFocused: \(isEditorFocused)")
        return isEditorFocused ? islandView : nil
    }

    override var inputAssistantItem: UITextInputAssistantItem {
        let item = super.inputAssistantItem
        item.leadingBarButtonGroups = []
        item.trailingBarButtonGroups = []
        return item
    }

    // This is a more aggressive approach - find and configure all UITextInput views
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

        // Observe app lifecycle to refresh view on foreground
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
        if let keyboardFrame = notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey]
            as? CGRect
        {
            // More reliable detection: Check if keyboard is actually on screen
            // When hardware keyboard is active, the keyboard frame is off-screen (y >= screen height)
            // When soft keyboard shows, it's on screen (y < screen height)
            let screenHeight = UIScreen.main.bounds.height
            let isKeyboardOnScreen = keyboardFrame.origin.y < screenHeight

            // Additional check: keyboard height must be substantial for soft keyboard
            let hasSubstantialHeight = keyboardFrame.height > 100

            // Soft keyboard is visible only if it's on screen AND has substantial height
            let isSoftKeyboard = isKeyboardOnScreen && hasSubstantialHeight

            // print("🎹 [keyboardWillShow] frame: \(keyboardFrame), screenHeight: \(screenHeight)")
            // print("🎹 [keyboardWillShow] y: \(keyboardFrame.origin.y), height: \(keyboardFrame.height)")
            // print("🎹 [keyboardWillShow] onScreen: \(isKeyboardOnScreen), substantial: \(hasSubstantialHeight)")
            // print("🎹 [keyboardWillShow] isSoftKeyboard: \(isSoftKeyboard)")

            // Update soft keyboard visibility state
            let previousState = isSoftKeyboardVisible
            isSoftKeyboardVisible = isSoftKeyboard
            hasPhysicalKeyboard = !isSoftKeyboard

            // print("🎹 [keyboardWillShow] state change: \(previousState) -> \(isSoftKeyboardVisible)")

            // Show/hide island view based on soft keyboard state
            if isSoftKeyboard {
                // print("🎹 [keyboardWillShow] ✅ Showing island menu")
                islandView?.isHidden = false
            } else {
                // print("🎹 [keyboardWillShow] 🚫 Hiding island menu (hardware keyboard)")
                islandView?.isHidden = true
            }

            if previousState != isSoftKeyboardVisible {
                notifyPhysicalKeyboardState()
            }

            // Only update if this is the system keyboard (not our custom inputView)
            // Our custom inputView won't have a consistent height initially
            // System keyboard + accessory is typically 300-350+ on iPhone
            if !isMenuOpen && keyboardFrame.height > 200 && isSoftKeyboard {
                // The keyboard frame includes the accessory view + safe area insets
                // Accessory view: 56pt (44pt container + 6pt top + 6pt bottom)
                // Plus safe area bottom inset (usually ~34pt on iPhones with notch, 0 on others)
                let accessoryWithSafeArea = islandView?.frame.height ?? 56
                let keyboardOnlyHeight = keyboardFrame.height - accessoryWithSafeArea

                // print("🎹 [keyboardWillShow] Updating keyboard height cache: \(keyboardOnlyHeight)")

                // Update cached height and the input view
                lastKeyboardHeight = keyboardOnlyHeight
                BlockTypeInputView.cachedKeyboardHeight = keyboardOnlyHeight
                blockTypeInputView?.updateHeight(keyboardOnlyHeight)
            }
        }
    }

    @objc private func keyboardDidShow(_ notification: Notification) {
        // Double-check after keyboard animation completes
        // This catches cases where keyboardWillShow was called during rapid transitions
        if let keyboardFrame = notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey]
            as? CGRect
        {
            let screenHeight = UIScreen.main.bounds.height
            let isKeyboardOnScreen = keyboardFrame.origin.y < screenHeight
            let hasSubstantialHeight = keyboardFrame.height > 100
            let isSoftKeyboard = isKeyboardOnScreen && hasSubstantialHeight

            // print("✅ [keyboardDidShow] frame: \(keyboardFrame), screenHeight: \(screenHeight)")
            // print("✅ [keyboardDidShow] y: \(keyboardFrame.origin.y), height: \(keyboardFrame.height)")
            // print("✅ [keyboardDidShow] onScreen: \(isKeyboardOnScreen), substantial: \(hasSubstantialHeight)")
            // print("✅ [keyboardDidShow] isSoftKeyboard: \(isSoftKeyboard)")

            let previousState = isSoftKeyboardVisible
            isSoftKeyboardVisible = isSoftKeyboard
            hasPhysicalKeyboard = !isSoftKeyboard

            // print("✅ [keyboardDidShow] state change: \(previousState) -> \(isSoftKeyboardVisible)")

            // Always ensure island visibility matches soft keyboard state after animation
            if isSoftKeyboard {
                // print("✅ [keyboardDidShow] ✅ Ensuring island menu is visible")
                islandView?.isHidden = false
            } else {
                // print("✅ [keyboardDidShow] 🚫 Ensuring island menu is hidden (hardware keyboard)")
                islandView?.isHidden = true
            }

            if previousState != isSoftKeyboardVisible {
                notifyPhysicalKeyboardState()
            }
        }
    }

    @objc private func keyboardWillHide(_ notification: Notification) {
        // print("⬇️ [keyboardWillHide] Previous state: \(isSoftKeyboardVisible)")

        // When keyboard hides, mark soft keyboard as not visible
        isSoftKeyboardVisible = false

        // print("⬇️ [keyboardWillHide] New state: \(isSoftKeyboardVisible)")
        // print("⬇️ [keyboardWillHide] Hiding island menu")

        // Hide the island menu directly
        islandView?.isHidden = true

        // Collapse formatting panel if expanded
        islandView?.collapseFormattingIfNeeded()

        // Re-detect physical keyboard status when keyboard hides
        // This helps catch hardware keyboard connect/disconnect events
        detectPhysicalKeyboard()
    }

    @objc private func keyboardDidHide(_ notification: Notification) {
        // print("❌ [keyboardDidHide] Confirming keyboard hidden, state: \(isSoftKeyboardVisible)")

        // Confirm keyboard is hidden after animation completes
        isSoftKeyboardVisible = false
        islandView?.isHidden = true

        // print("❌ [keyboardDidHide] Island menu should be hidden, isHidden: \(islandView?.isHidden ?? true)")
    }

    @available(iOS 14.0, *)
    @objc private func keyboardDidConnect(_ notification: Notification) {
        // print("⌨️ [keyboardDidConnect] Hardware keyboard connected")
        // Don't immediately assume physical keyboard - wait for keyboardWillShow
        // to detect based on frame height, as user might still use soft keyboard
        // Even with a connected Bluetooth keyboard, iPad users can choose soft keyboard
    }

    @available(iOS 14.0, *)
    @objc private func keyboardDidDisconnect(_ notification: Notification) {
        // print("⌨️ [keyboardDidDisconnect] Hardware keyboard disconnected")
        // When hardware keyboard disconnects, assume soft keyboard will be used
        // Check if any keyboards are still connected
        if GCKeyboard.coalesced == nil {
            // print("⌨️ [keyboardDidDisconnect] No keyboards connected, switching to soft keyboard mode")
            hasPhysicalKeyboard = false
            notifyPhysicalKeyboardState()
            // Note: Island visibility will be updated when keyboard actually shows
        }
    }

    @objc private func appWillEnterForeground(_ notification: Notification) {
        // Force layout update when app enters foreground
        DispatchQueue.main.async { [weak self] in
            self?.setNeedsLayout()
            self?.layoutIfNeeded()
        }
    }

    @objc private func appDidBecomeActive(_ notification: Notification) {
        // Ensure WebView is visible and properly rendered after becoming active
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }

            // Force re-render by toggling opacity
            self.isOpaque = true
            self.isOpaque = false

            // Update background color
            if let backgroundColor = UIColor(named: "Background") {
                self.backgroundColor = backgroundColor
                self.scrollView.backgroundColor = backgroundColor
            }

            // Force layout pass
            self.setNeedsLayout()
            self.layoutIfNeeded()

            // Notify web content that app has returned
            let javascript = """
                window.postMessage({type: 'app-foreground'}, '*');
                """
            self.evaluateJavaScript(javascript, completionHandler: nil)
        }
    }

    private func detectPhysicalKeyboard() {
        // print("🔍 [detectPhysicalKeyboard] Checking keyboard status...")
        // Initial detection - assume no physical keyboard
        // The actual state will be updated when keyboard appears based on frame height
        // in keyboardWillShow notification
        //
        // Note: GCKeyboard.coalesced can be unreliable on iPad because a Bluetooth keyboard
        // might be paired but the user could still choose to use the soft keyboard
        let previousState = hasPhysicalKeyboard

        // Only trust GCKeyboard when keyboard is hiding (user switching away)
        // When keyboard is showing, we detect based on frame height in keyboardWillShow
        if GCKeyboard.coalesced == nil {
            hasPhysicalKeyboard = false
            // print("🔍 [detectPhysicalKeyboard] No GCKeyboard detected")
        } else {
            // print("🔍 [detectPhysicalKeyboard] GCKeyboard exists (but might not be in use)")
        }

        // print("🔍 [detectPhysicalKeyboard] hasPhysicalKeyboard: \(previousState) -> \(hasPhysicalKeyboard)")

        // Notify WebView if state changed
        if previousState != hasPhysicalKeyboard {
            // print("🔍 [detectPhysicalKeyboard] State changed, notifying web")
            notifyPhysicalKeyboardState()
            // Note: Island visibility is controlled via isHidden property in keyboard show/hide handlers
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

        // Wire up block type button to open block menu
        island.onBlockType = { [weak self] in self?.onFormat() }

        // Wire up formatting buttons
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

        // Start hidden - will be shown when soft keyboard appears
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
            // Reload input views to update inputAccessoryView based on editor focus state
            // This ensures island toolbar only shows for editor's hidden input, not other inputs
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
            // Close the block menu
            isMenuOpen = false
            dummyTextField.resignFirstResponder()
            self.evaluateJavaScript(
                "if(window.IOSBridge && window.IOSBridge.focus) window.IOSBridge.focus()",
                completionHandler: nil)
            updateToolbarState()
        } else {
            // Try to let web handle it first (for link/image drawers)
            self.evaluateJavaScript(
                "(function() { if(window.IOSBridge && window.IOSBridge.onFormatButtonClick) { return window.IOSBridge.onFormatButtonClick(); } return false; })()",
                completionHandler: { result, error in
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
            self.evaluateJavaScript(
                "if(window.IOSBridge && window.IOSBridge.focus) window.IOSBridge.focus()",
                completionHandler: nil)
        } else {
            // Dismiss keyboard
            self.endEditing(true)
        }
        updateToolbarState()
    }

    func applyBlockType(_ type: String) {
        let js =
            "if(window.IOSBridge && window.IOSBridge.setBlockType) window.IOSBridge.setBlockType('\(type)')"
        evaluateJavaScript(js, completionHandler: nil)

        // Dismiss menu after selection and return to keyboard
        isMenuOpen = false
        dummyTextField.resignFirstResponder()
        self.evaluateJavaScript(
            "if(window.IOSBridge && window.IOSBridge.focus) window.IOSBridge.focus()",
            completionHandler: nil)

        updateToolbarState()
    }

    // Recursively find and configure all text input views to hide shortcuts bar
    func configureAllTextInputs() {
        // Small delay to ensure WebView's internal views are created
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            self?.recursivelyConfigureSubviews(self)
        }
    }

    private func recursivelyConfigureSubviews(_ view: UIView?) {
        guard let view = view else { return }

        // Check if this view conforms to UITextInput protocol
        if let textInput = view as? (UIView & UITextInput) {
            // Set the inputAssistantItem to hide shortcuts bar
            textInput.inputAssistantItem.leadingBarButtonGroups = []
            textInput.inputAssistantItem.trailingBarButtonGroups = []
            // print("✅ Configured text input view: \(type(of: textInput))")
        }

        // Recursively check all subviews
        for subview in view.subviews {
            recursivelyConfigureSubviews(subview)
        }
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
        let script = WKUserScript(
            source: scriptSource, injectionTime: .atDocumentStart, forMainFrameOnly: false)
        userContentController.addUserScript(script)

        // Inject script to disable keyboard shortcuts bar on all input elements
        // The shortcuts bar appears due to iOS's inputAssistantItem on input elements
        // We can't directly control it from JavaScript, but we can set input attributes
        let disableShortcutsBarScript = """
            (function() {
                // CSS to hide the shortcuts bar
                const style = document.createElement('style');
                style.textContent = `
                    input, textarea {
                        -webkit-user-select: text !important;
                    }
                `;
                document.head.appendChild(style);
                
                // Function to configure input elements to minimize iOS keyboard accessories
                function configureInput(input) {
                    if (!input) return;
                    
                    // These attributes help reduce iOS keyboard accessories
                    // but won't completely hide the shortcuts bar on iPad with hardware keyboard
                    input.setAttribute('autocorrect', 'off');
                    input.setAttribute('autocapitalize', 'off');
                    input.setAttribute('spellcheck', 'false');
                }
                
                // Apply to existing and future input elements
                function applyToExistingInputs() {
                    const inputs = document.querySelectorAll('input, textarea');
                    inputs.forEach(configureInput);
                }
                
                const observer = new MutationObserver(function(mutations) {
                    mutations.forEach(function(mutation) {
                        mutation.addedNodes.forEach(function(node) {
                            if (node.nodeType === 1) {
                                if (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA') {
                                    configureInput(node);
                                }
                                if (node.querySelectorAll) {
                                    const inputs = node.querySelectorAll('input, textarea');
                                    inputs.forEach(configureInput);
                                }
                            }
                        });
                    });
                });
                
                if (document.readyState === 'loading') {
                    document.addEventListener('DOMContentLoaded', function() {
                        applyToExistingInputs();
                        if (document.body) {
                            observer.observe(document.body, { childList: true, subtree: true });
                        }
                    });
                } else {
                    applyToExistingInputs();
                    if (document.body) {
                        observer.observe(document.body, { childList: true, subtree: true });
                    }
                }
            })();
            """
        let disableShortcutsScript = WKUserScript(
            source: disableShortcutsBarScript, injectionTime: .atDocumentEnd,
            forMainFrameOnly: false)
        userContentController.addUserScript(disableShortcutsScript)

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
                let rootViewController = windowScene.windows.first?.rootViewController
            {
                context.coordinator.imagePickerCoordinator?.presentingViewController =
                    rootViewController
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
            if let keyboardFrame = notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey]
                as? CGRect
            {
                let keyboardHeight = keyboardFrame.height
                let js =
                    "window.postMessage({type: 'keyboard-show', height: \(keyboardHeight)}, '*');"
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
                // Configure text inputs to hide shortcuts bar
                customWebView.configureAllTextInputs()
            }
        }

        func webView(
            _ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error
        ) {
            withAnimation {
                parent.isLoading = false
            }
        }

        func webView(
            _ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge,
            completionHandler:
                @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
        ) {
            // Trust localhost SSL certificates for development
            if challenge.protectionSpace.host.starts(with: "192.168.")
                || challenge.protectionSpace.host == "localhost"
                || challenge.protectionSpace.host == "127.0.0.1"
            {
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
