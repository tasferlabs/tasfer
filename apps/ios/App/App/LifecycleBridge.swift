import UIKit
import WebKit

/// Bridges iOS app-lifecycle transitions to the web app's background-sync
/// controller (`window.__cypherLifecycle`, see `sync-lifecycle.ts`).
///
/// On background it opens a `beginBackgroundTask` window so the WebView's JS
/// run loop stays alive long enough to flush the in-flight sync round and tear
/// down connections cleanly, then tells the web side to pause. The web side
/// calls back `Lifecycle.postMessage({action:'flushComplete'})` once teardown
/// finishes, releasing the task early; a watchdog force-ends it otherwise.
///
/// On foreground it tells the web side to resume (reconnect). Resume is a no-op
/// on the JS side when sync was never paused, so transient activations (Control
/// Center, notifications) are harmless.
class LifecycleBridge: NSObject, WKScriptMessageHandler {
    weak var webView: WKWebView?

    private var bgTask: UIBackgroundTaskIdentifier = .invalid

    /// Upper bound on the flush window. Must stay well under iOS's background
    /// grace and above the web side's FLUSH_TIMEOUT_MS (2.5s) so JS can finish.
    private let flushWatchdogSeconds: TimeInterval = 4.0

    override init() {
        super.init()
        let nc = NotificationCenter.default
        nc.addObserver(
            self, selector: #selector(appDidEnterBackground),
            name: UIApplication.didEnterBackgroundNotification, object: nil)
        nc.addObserver(
            self, selector: #selector(appDidBecomeActive),
            name: UIApplication.didBecomeActiveNotification, object: nil)
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
        endTask()
    }

    // MARK: - Lifecycle notifications

    @objc private func appDidEnterBackground() {
        beginFlushWindow()
        evaluateLifecycle("onPause")
    }

    @objc private func appDidBecomeActive() {
        // Any pending flush is moot once we're foreground again.
        endTask()
        evaluateLifecycle("onResume")
    }

    // MARK: - Web callback

    func userContentController(
        _ userContentController: WKUserContentController, didReceive message: WKScriptMessage
    ) {
        guard let body = message.body as? [String: Any],
            let action = body["action"] as? String
        else { return }

        if action == "flushComplete" {
            // Web side finished tearing down — release the background task now
            // instead of waiting out the watchdog.
            endTask()
        }
    }

    // MARK: - Background task management

    private func beginFlushWindow() {
        endTask()  // never leak a prior task
        bgTask = UIApplication.shared.beginBackgroundTask(withName: "cypher.sync.flush") {
            [weak self] in
            // Expiration handler — the OS is reclaiming us; end cleanly.
            self?.endTask()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + flushWatchdogSeconds) { [weak self] in
            self?.endTask()
        }
    }

    /// Idempotent; safe to call from the expiration handler, the watchdog, and
    /// the flushComplete callback.
    private func endTask() {
        guard bgTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(bgTask)
        bgTask = .invalid
    }

    // MARK: - Helpers

    private func evaluateLifecycle(_ fn: String) {
        let js = "window.__cypherLifecycle?.\(fn)?.();"
        DispatchQueue.main.async { [weak self] in
            self?.webView?.evaluateJavaScript(js, completionHandler: nil)
        }
    }
}
