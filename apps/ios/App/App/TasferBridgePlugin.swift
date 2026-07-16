import Capacitor

/// Placeholder Capacitor plugin for any future native calls via Capacitor's plugin system.
/// Currently, all native bridge communication uses WKScriptMessageHandler directly
/// (IOSBridge and Storage message handlers) for compatibility with the existing web app.
@objc(TasferBridgePlugin)
class TasferBridgePlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "TasferBridgePlugin"
    let jsName = "TasferBridge"
    let pluginMethods: [CAPPluginMethod] = []
}
