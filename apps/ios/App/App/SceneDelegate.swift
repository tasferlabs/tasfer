import UIKit
import Capacitor

/// Apps built against the iOS 27 SDK must adopt the UIScene life cycle; UIKit
/// rejects the old app-delegate launch path ("UIScene life cycle is required
/// for apps built with this SDK"), which under the debugger stops on a runtime
/// issue before `AppDelegate` ever gets to run.
///
/// The window and its root `TasferViewController` still come from
/// `Main.storyboard`, now named by the scene configuration in `Info.plist`
/// rather than by `UIMainStoryboardFile`.
class SceneDelegate: UIResponder, UIWindowSceneDelegate {

    var window: UIWindow?

    func scene(
        _ scene: UIScene, willConnectTo session: UISceneSession,
        options connectionOptions: UIScene.ConnectionOptions
    ) {
        // Set background color to prevent white flash on launch
        window?.backgroundColor = UIColor(named: "Background")
        // A cold launch delivers its url and activity here instead of to the
        // app delegate, so Capacitor's proxy has to be handed both by hand.
        open(connectionOptions.urlContexts)
        if let userActivity = connectionOptions.userActivities.first {
            self.continue(userActivity)
        }
    }

    // Called when the app was opened with a url. Feel free to add additional
    // processing here, but if you want the App API to support tracking app url
    // opens, make sure to keep this call.
    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        open(URLContexts)
    }

    // Called when the app was opened with an activity, including Universal
    // Links. Feel free to add additional processing here, but if you want the
    // App API to support tracking app url opens, make sure to keep this call.
    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        self.continue(userActivity)
    }

    // MARK: - Capacitor forwarding

    private func open(_ contexts: Set<UIOpenURLContext>) {
        for context in contexts {
            var options: [UIApplication.OpenURLOptionsKey: Any] = [
                .openInPlace: context.options.openInPlace
            ]
            options[.sourceApplication] = context.options.sourceApplication
            options[.annotation] = context.options.annotation
            _ = ApplicationDelegateProxy.shared.application(
                UIApplication.shared, open: context.url, options: options)
        }
    }

    private func `continue`(_ userActivity: NSUserActivity) {
        _ = ApplicationDelegateProxy.shared.application(
            UIApplication.shared, continue: userActivity, restorationHandler: { _ in })
    }
}
