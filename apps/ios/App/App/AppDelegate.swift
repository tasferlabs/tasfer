import UIKit
import Capacitor

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    // The app runs on the UIScene life cycle (required by the iOS 27 SDK), so
    // the window, the launch url and the per-scene activity callbacks live in
    // `SceneDelegate`. What is left here is process-wide setup.

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Seed the Settings-bundle default so `UserDefaults` reflects the
        // toggle's DefaultValue before the user ever opens the system Settings
        // app (the bundle's DefaultValue alone is not registered until then).
        UserDefaults.standard.register(defaults: ["dev_tools_enabled": false])
        excludeAppDataFromBackup()
        return true
    }

    // Local-first: documents never leave the device via iCloud/device backup
    // (parity with allowBackup="false" on Android). Covers Documents (document
    // store, SQLite) and Library (WebView storage). Reapplied every launch
    // because the flag does not survive a directory being recreated.
    private func excludeAppDataFromBackup() {
        let dirs: [FileManager.SearchPathDirectory] = [.documentDirectory, .libraryDirectory]
        for dir in dirs {
            guard var url = FileManager.default.urls(for: dir, in: .userDomainMask).first else { continue }
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try? url.setResourceValues(values)
        }
    }
}
