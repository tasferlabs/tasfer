//
//  ContentView.swift
//  ios
//
//  Created by Hamza Khuswan on 2025-12-28.
//

import SwiftUI
import WebKit

struct ContentView: View {
    @State private var isLoading = true
    
    var body: some View {
        ZStack {
            WebView(url: URL(string: "https://localhost:5173/")!, isLoading: $isLoading)
                .edgesIgnoringSafeArea(.all)
            
            if isLoading {
                LoadingView()
                    .transition(.opacity)
            }
        }
    }
}

class ClipboardBridge: NSObject, WKScriptMessageHandler {
    weak var webView: WKWebView?
    
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
        default:
            break
        }
    }
}

class BlockTypeInputView: UIView {
    var onSelect: ((String) -> Void)?
    
    override init(frame: CGRect) {
        super.init(frame: frame)
        setupUI()
    }
    
    required init?(coder: NSCoder) {
        super.init(coder: coder)
        setupUI()
    }
    
    // Suggest a default height; width is provided by the hosting view.
    override var intrinsicContentSize: CGSize {
        CGSize(width: UIView.noIntrinsicMetric, height: 300)
    }
    
    private func setupUI() {
        self.backgroundColor = .systemGroupedBackground
        self.autoresizingMask = [.flexibleHeight]
        
        let stack = UIStackView()
        stack.axis = .vertical
        stack.spacing = 10
        stack.distribution = .fillEqually
        stack.translatesAutoresizingMaskIntoConstraints = false
        
        addSubview(stack)
        
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: topAnchor, constant: 20),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -20),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -20)
        ])
        
        let types = [
            ("Heading 1", "heading1"),
            ("Heading 2", "heading2"),
            ("Heading 3", "heading3"),
            ("Paragraph", "paragraph")
        ]
        
        for (title, value) in types {
            let button = UIButton(type: .system)
            button.setTitle(title, for: .normal)
            button.backgroundColor = .secondarySystemGroupedBackground
            button.layer.cornerRadius = 8
            button.setTitleColor(.label, for: .normal)
            
            let action = UIAction { [weak self] _ in
                self?.onSelect?(value)
            }
            button.addAction(action, for: .touchUpInside)
            
            stack.addArrangedSubview(button)
        }
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
        
        let dismissImageName = isMenuOpen ? "xmark" : "keyboard_dismiss"
        if dismissImageName == "xmark" {
            let config = UIImage.SymbolConfiguration(scale: .medium)
            dismissBtn.setImage(UIImage(systemName: "xmark", withConfiguration: config), for: .normal)
        } else if let image = UIImage(named: "keyboard_dismiss") {
            dismissBtn.setImage(image.withRenderingMode(.alwaysTemplate), for: .normal)
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
    
    override var inputAccessoryView: UIView? {
        return islandView
    }
    
    override init(frame: CGRect, configuration: WKWebViewConfiguration) {
        super.init(frame: frame, configuration: configuration)
        setupDummyInput()
    }
    
    required init?(coder: NSCoder) {
        super.init(coder: coder)
        setupDummyInput()
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

    @objc func onUndo() {
        self.evaluateJavaScript("if(window.IOSBridge && window.IOSBridge.undo) window.IOSBridge.undo()", completionHandler: nil)
    }

    @objc func onRedo() {
        self.evaluateJavaScript("if(window.IOSBridge && window.IOSBridge.redo) window.IOSBridge.redo()", completionHandler: nil)
    }

    @objc func onFormat() {
        isMenuOpen = !isMenuOpen
        if isMenuOpen {
            dummyTextField.becomeFirstResponder()
        } else {
            dummyTextField.resignFirstResponder()
            self.evaluateJavaScript("if(window.IOSBridge && window.IOSBridge.focus) window.IOSBridge.focus()", completionHandler: nil)
        }
        updateToolbarState()
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
    
    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }
    
    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        let userContentController = WKUserContentController()
        
        let clipboardBridge = ClipboardBridge()
        userContentController.add(clipboardBridge, name: "IOSBridge")
        
        // Inject alias for IOSBridge as a wrapper object to allow extension
        let scriptSource = """
        window.IOSBridge = {
            postMessage: function(msg) { window.webkit.messageHandlers.IOSBridge.postMessage(msg); }
        };
        """
        let script = WKUserScript(source: scriptSource, injectionTime: .atDocumentStart, forMainFrameOnly: false)
        userContentController.addUserScript(script)
        
        configuration.userContentController = userContentController
        
        let webView = CustomWebView(frame: .zero, configuration: configuration)
        webView.setupAccessoryView()
        
        webView.navigationDelegate = context.coordinator
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.showsVerticalScrollIndicator = false
        webView.scrollView.showsHorizontalScrollIndicator = false
        webView.scrollView.bounces = false
        
        clipboardBridge.webView = webView
        
        let preferences = WKWebpagePreferences()
        preferences.allowsContentJavaScript = true
        webView.configuration.defaultWebpagePreferences = preferences
        // Removed deprecated: webView.configuration.preferences.javaScriptEnabled = true
        
        webView.allowsBackForwardNavigationGestures = true
        
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
        if webView.url == nil {
            let request = URLRequest(url: url)
            webView.load(request)
        }
    }
    
    class Coordinator: NSObject, WKNavigationDelegate {
        var parent: WebView
        
        init(_ parent: WebView) {
            self.parent = parent
        }
        
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            withAnimation {
                parent.isLoading = false
            }
        }
        
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            withAnimation {
                parent.isLoading = false
            }
        }
        
        func webView(_ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
            // Trust localhost SSL certificates for development
            if challenge.protectionSpace.host == "localhost" || 
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
        Color.white
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
