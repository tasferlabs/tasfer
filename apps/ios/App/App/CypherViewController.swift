import UIKit
import WebKit
import Capacitor

class CypherViewController: CAPBridgeViewController {

    override func viewDidLoad() {
        super.viewDidLoad()

        // Set background color to prevent white flash
        if let backgroundColor = UIColor(named: "Background") {
            view.backgroundColor = backgroundColor
        }
    }

    override func capacitorDidLoad() {
        // Register custom plugins
        bridge?.registerPluginInstance(CypherBridgePlugin())
    }

    override func webView(with frame: CGRect, configuration: WKWebViewConfiguration) -> WKWebView {
        // Inject the IOSBridge script at document start
        let userContentController = configuration.userContentController

        let scriptSource = """
            (function() {
                // Callback registry for async storage responses
                window.__nativeStorageCallbacks = new Map();
                let callbackCounter = 0;

                // Helper to call native storage and return a Promise
                function callStorage(action, params) {
                    return new Promise((resolve, reject) => {
                        const callbackId = 'cb_' + (++callbackCounter) + '_' + Date.now();

                        window.__nativeStorageCallbacks.set(callbackId, function(response) {
                            window.__nativeStorageCallbacks.delete(callbackId);
                            if (response.error) {
                                reject(new Error(response.error));
                            } else {
                                resolve(response.result);
                            }
                        });

                        window.webkit.messageHandlers.Storage.postMessage({
                            action: action,
                            callbackId: callbackId,
                            ...params
                        });

                        // Timeout after 30 seconds
                        setTimeout(function() {
                            if (window.__nativeStorageCallbacks.has(callbackId)) {
                                window.__nativeStorageCallbacks.delete(callbackId);
                                reject(new Error('Native storage call timed out'));
                            }
                        }, 30000);
                    });
                }

                // Helper to call native IOSBridge message handler and return a Promise
                function callNative(msg) {
                    return new Promise(function(resolve) {
                        window.webkit.messageHandlers.IOSBridge.postMessage(msg);
                        resolve();
                    });
                }

                window.CypherBridge = {
                    clipboard: {
                        copy: function(text) { return callNative({action: 'copy', text: text}); },
                        cut: function(text) { return callNative({action: 'cut', text: text}); },
                        paste: function() {
                            return callStorage('paste', {});
                        }
                    },
                    haptic: {
                        trigger: function(style) { return callNative({action: 'haptic', style: style}); }
                    },
                    editor: {
                        setFocused: function(focused) { return callNative({action: 'editor-focus', focused: focused}); },
                        updateUndoRedoState: function(canUndo, canRedo) { return callNative({action: 'undo-redo-state', canUndo: canUndo, canRedo: canRedo}); },
                        updateToolbarIcon: function(iconType) { return callNative({action: 'toolbar-icon', iconType: iconType}); },
                        updateFormattingState: function(bold, italic, code, strikethrough) { return callNative({action: 'formatting-state', bold: bold, italic: italic, code: code, strikethrough: strikethrough}); },
                        setColorScheme: function(scheme) { return callNative({action: 'setColorScheme', colorScheme: scheme}); }
                    },
                    navigation: {
                        openUrl: function(url) { return callNative({action: 'open-url', url: url}); },
                        openPhotoLibrary: function() { return callNative({action: 'open-photo-library'}); },
                        openCamera: function() { return callNative({action: 'open-camera'}); }
                    },
                    files: {
                        shareFile: function(base64Data, fileName, mimeType) {
                            return callStorage('shareFile', { data: base64Data, fileName: fileName, mimeType: mimeType });
                        }
                    },
                    storage: {
                        write: function(path, base64Data) { return callStorage('write', { path: path, data: base64Data }); },
                        read: function(path) { return callStorage('read', { path: path }); },
                        delete: function(path) { return callStorage('delete', { path: path }); },
                        list: function(path) { return callStorage('list', { path: path }); },
                        exists: function(path) { return callStorage('exists', { path: path }); },
                        getInfo: function() { return callStorage('getStorageInfo', {}); }
                    }
                };
            })();
            """
        let script = WKUserScript(
            source: scriptSource, injectionTime: .atDocumentStart, forMainFrameOnly: false)
        userContentController.addUserScript(script)

        // Inject script to disable keyboard shortcuts bar on all input elements
        let disableShortcutsBarScript = """
            (function() {
                const style = document.createElement('style');
                style.textContent = `
                    input, textarea {
                        -webkit-user-select: text !important;
                    }
                `;
                document.head.appendChild(style);

                function configureInput(input) {
                    if (!input) return;
                    input.setAttribute('autocorrect', 'off');
                    input.setAttribute('autocapitalize', 'off');
                    input.setAttribute('spellcheck', 'false');
                }

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

        // Add native message handlers
        let clipboardBridge = ClipboardBridge()
        let storageBridge = StorageBridge()
        let imagePickerCoordinator = ImagePickerCoordinator()
        clipboardBridge.imagePickerCoordinator = imagePickerCoordinator

        userContentController.add(clipboardBridge, name: "IOSBridge")
        userContentController.add(storageBridge, name: "Storage")

        // Store references so they aren't deallocated
        self._clipboardBridge = clipboardBridge
        self._storageBridge = storageBridge
        self._imagePickerCoordinator = imagePickerCoordinator

        // Create the custom web view
        let webView = CustomWebView(frame: frame, configuration: configuration)
        webView.setupAccessoryView()

        // Set WebView background to theme color to prevent white flash
        webView.isOpaque = false
        if let backgroundColor = UIColor(named: "Background") {
            webView.backgroundColor = backgroundColor
            webView.scrollView.backgroundColor = backgroundColor

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

        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.showsVerticalScrollIndicator = false
        webView.scrollView.showsHorizontalScrollIndicator = false
        webView.scrollView.bounces = false

        // Wire up bridges to the web view
        clipboardBridge.webView = webView
        imagePickerCoordinator.webView = webView
        storageBridge.webView = webView
        storageBridge.presentingViewController = self

        // Set presenting view controller for image picker
        imagePickerCoordinator.presentingViewController = self

        // Register keyboard notifications for web
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

        #if DEBUG
            if #available(iOS 16.4, *) {
                webView.isInspectable = true
            }
        #endif

        return webView
    }

    // MARK: - Strong references to bridges
    private var _clipboardBridge: ClipboardBridge?
    private var _storageBridge: StorageBridge?
    private var _imagePickerCoordinator: ImagePickerCoordinator?
}
