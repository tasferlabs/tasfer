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

    override func viewSafeAreaInsetsDidChange() {
        super.viewSafeAreaInsetsDidChange()
        captureHomeIndicatorInset()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        captureHomeIndicatorInset()
    }

    /// Record the current home-indicator inset onto the web view so the native
    /// keyboard accessory can reserve it while a hardware keyboard docks the bar
    /// at the screen bottom. At that point every live safe area reads 0 (the bar
    /// covers the home indicator), so the accessory relies on this value taken
    /// while no keyboard is docked. Only positive readings are kept, so the last
    /// real inset (from launch or a rotation) survives the docked collapse.
    private func captureHomeIndicatorInset() {
        let bottom = view.safeAreaInsets.bottom
        guard bottom > 0 else { return }
        webView?.cypherHomeIndicatorInset = bottom
    }

    override func capacitorDidLoad() {
        // Register custom plugins
        bridge?.registerPluginInstance(CypherBridgePlugin())
    }

    override func webView(with frame: CGRect, configuration: WKWebViewConfiguration) -> WKWebView {
        // Inject the IOSBridge script at document start
        let userContentController = configuration.userContentController

        // The native context menu uses UIEditMenuInteraction (iOS 16+). Only
        // expose `editor.showContextMenu` where it's backed by a real handler;
        // on iOS 15 the property stays undefined and the web host falls back to
        // its own popover (the bridge method is optional in TypeScript).
        let contextMenuJS: String
        if #available(iOS 16.0, *) {
            contextMenuJS = """
                ,
                        showContextMenu: function(req) {
                            return new Promise(function(resolve) {
                                var callbackId = 'ctx_' + (++callbackCounter) + '_' + Date.now();
                                window.__nativeContextMenuCallbacks.set(callbackId, function(response) {
                                    window.__nativeContextMenuCallbacks.delete(callbackId);
                                    resolve(response && response.id ? response.id : null);
                                });
                                window.webkit.messageHandlers.ContextMenu.postMessage({
                                    callbackId: callbackId,
                                    model: req.model,
                                    anchor: req.anchor
                                });
                            });
                        }
                """
        } else {
            contextMenuJS = ""
        }

        // Read the "Show Developer Tools" toggle from the app's Settings-bundle
        // (system Settings app) and inject it into the bridge so the web app can
        // surface its in-app developer toolbar without an env/build change.
        let devToolsEnabled = UserDefaults.standard.bool(forKey: "dev_tools_enabled")

        let scriptSource = """
            (function() {
                // Callback registry for async storage responses
                window.__nativeStorageCallbacks = new Map();
                // Callback registry for native context-menu selections
                window.__nativeContextMenuCallbacks = new Map();
                let callbackCounter = 0;

                // Helper to call native storage and return a Promise.
                // `timeoutMs` is the JS-side guard; defaults to 30s when
                // omitted. Pass a LARGER value for actions backed by a native
                // operation with its own safety timeout (e.g. htmlToPdf) so the
                // native side reports its specific error first. Pass 0 to
                // DISABLE the guard for user-interactive actions (e.g.
                // shareFile presents a share sheet that the user may keep open
                // for any length of time while choosing a destination).
                function callStorage(action, params, timeoutMs) {
                    return new Promise((resolve, reject) => {
                        const callbackId = 'cb_' + (++callbackCounter) + '_' + Date.now();
                        const ms = timeoutMs === undefined ? 30000 : timeoutMs;

                        let timer = null;
                        if (ms > 0) {
                            timer = setTimeout(function() {
                                if (window.__nativeStorageCallbacks.has(callbackId)) {
                                    window.__nativeStorageCallbacks.delete(callbackId);
                                    reject(new Error('Native storage call timed out'));
                                }
                            }, ms);
                        }

                        window.__nativeStorageCallbacks.set(callbackId, function(response) {
                            if (timer) clearTimeout(timer);
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
                    devToolsEnabled: \(devToolsEnabled),
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
                        setColorScheme: function(scheme) { return callNative({action: 'setColorScheme', colorScheme: scheme}); }\(contextMenuJS)
                    },
                    navigation: {
                        openUrl: function(url) { return callNative({action: 'open-url', url: url}); },
                        openPhotoLibrary: function() { return callNative({action: 'open-photo-library'}); },
                        openCamera: function() { return callNative({action: 'open-camera'}); }
                    },
                    files: {
                        shareFile: function(base64Data, fileName, mimeType) {
                            // No timeout (0): the share sheet is interactive and
                            // the user may take arbitrarily long to pick a
                            // destination in Files. The native completion
                            // handler resolves this when the sheet is dismissed.
                            return callStorage('shareFile', { data: base64Data, fileName: fileName, mimeType: mimeType }, 0);
                        },
                        htmlToPdf: function(html) {
                            // 35s JS guard > the native PdfRenderer's 30s safety
                            // timeout (see PdfRenderer.swift), so a slow render
                            // surfaces "PDF render timed out" rather than the
                            // generic "Native storage call timed out". Mirrors
                            // the Android bridge.
                            return callStorage('htmlToPdf', { html: html }, 35000);
                        }
                    },
                    storage: {
                        write: function(path, base64Data) { return callStorage('write', { path: path, data: base64Data }); },
                        read: function(path) { return callStorage('read', { path: path }); },
                        delete: function(path) { return callStorage('delete', { path: path }); },
                        list: function(path) { return callStorage('list', { path: path }); },
                        exists: function(path) { return callStorage('exists', { path: path }); },
                        getInfo: function() { return callStorage('getStorageInfo', {}); }
                    },
                    lifecycle: {
                        // Tell native the background-sync teardown finished so it
                        // can release the beginBackgroundTask window early.
                        endFlush: function() {
                            window.webkit.messageHandlers.Lifecycle.postMessage({ action: 'flushComplete' });
                        }
                    }
                };
            })();
            """
        let script = WKUserScript(
            source: scriptSource, injectionTime: .atDocumentStart, forMainFrameOnly: false)
        userContentController.addUserScript(script)

        // Add native message handlers
        let clipboardBridge = ClipboardBridge()
        let storageBridge = StorageBridge()
        let imagePickerCoordinator = ImagePickerCoordinator()
        let keyboardToolbarBridge = KeyboardToolbarBridge()
        let lifecycleBridge = LifecycleBridge()
        clipboardBridge.imagePickerCoordinator = imagePickerCoordinator

        userContentController.add(clipboardBridge, name: "IOSBridge")
        userContentController.add(storageBridge, name: "Storage")
        userContentController.add(keyboardToolbarBridge, name: "KeyboardToolbar")
        userContentController.add(keyboardToolbarBridge, name: "KeyboardToolbarFocus")
        userContentController.add(lifecycleBridge, name: "Lifecycle")

        // Store references so they aren't deallocated
        self._clipboardBridge = clipboardBridge
        self._storageBridge = storageBridge
        self._imagePickerCoordinator = imagePickerCoordinator
        self._keyboardToolbarBridge = keyboardToolbarBridge
        self._lifecycleBridge = lifecycleBridge

        // Native context menu (iOS 16+). Registered only where the JS bridge
        // method above is exposed, so iOS 15 never posts to a missing handler.
        if #available(iOS 16.0, *) {
            let contextMenuBridge = ContextMenuBridge()
            userContentController.add(contextMenuBridge, name: "ContextMenu")
            self._contextMenuBridge = contextMenuBridge
        }

        // Create the web view — use our subclass to suppress the native input accessory bar
        // (the up/down/checkmark row) so only our custom MobileKeyboardToolbar is shown.
        let webView = NoAccessoryWebView(frame: frame, configuration: configuration)

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
        keyboardToolbarBridge.webView = webView
        lifecycleBridge.webView = webView
        if #available(iOS 16.0, *) {
            (self._contextMenuBridge as? ContextMenuBridge)?.webView = webView
        }

        // Set presenting view controller for image picker
        imagePickerCoordinator.presentingViewController = self

        // Allow Safari Web Inspector when developer tools are enabled (always in
        // DEBUG builds; in release only when the Settings toggle is on).
        if #available(iOS 16.4, *) {
            #if DEBUG
                webView.isInspectable = true
            #else
                webView.isInspectable = devToolsEnabled
            #endif
        }

        return webView
    }

    // MARK: - Strong references to bridges
    private var _clipboardBridge: ClipboardBridge?
    private var _storageBridge: StorageBridge?
    private var _imagePickerCoordinator: ImagePickerCoordinator?
    private var _keyboardToolbarBridge: KeyboardToolbarBridge?
    private var _lifecycleBridge: LifecycleBridge?
    // Type-erased so the property declaration doesn't reference the
    // iOS 16-only ContextMenuBridge type on a class that also runs on iOS 15.
    private var _contextMenuBridge: AnyObject?
}

private extension UIColor {
    func toHex() -> String {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        getRed(&r, green: &g, blue: &b, alpha: &a)
        return String(format: "#%02X%02X%02X", Int(r * 255), Int(g * 255), Int(b * 255))
    }
}
