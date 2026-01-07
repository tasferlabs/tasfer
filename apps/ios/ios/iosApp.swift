//
//  iosApp.swift
//  ios
//
//  Created by Hamza Khuswan on 2025-12-28.
//

import SwiftUI
import UIKit

class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey : Any]? = nil) -> Bool {
        // Set the default background color for all windows to prevent white flash
        if let windowScene = UIApplication.shared.connectedScenes.first as? UIWindowScene {
            for window in windowScene.windows {
                window.backgroundColor = UIColor(named: "Background")
            }
        }
        return true
    }
    
    func application(_ application: UIApplication, configurationForConnecting connectingSceneSession: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let sceneConfig = UISceneConfiguration(name: nil, sessionRole: connectingSceneSession.role)
        sceneConfig.delegateClass = SceneDelegate.self
        return sceneConfig
    }
}

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    
    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }
        
        // Create or get the window
        if window == nil {
            window = windowScene.windows.first ?? UIWindow(windowScene: windowScene)
        }
        
        // Set background color for the window immediately
        window?.backgroundColor = UIColor(named: "Background")
        
        // Set background for all existing windows
        for win in windowScene.windows {
            win.backgroundColor = UIColor(named: "Background")
        }
    }
    
    func sceneWillEnterForeground(_ scene: UIScene) {
        // Update background when returning to foreground (handles theme changes)
        window?.backgroundColor = UIColor(named: "Background")
        
        if let windowScene = scene as? UIWindowScene {
            for win in windowScene.windows {
                win.backgroundColor = UIColor(named: "Background")
            }
        }
    }
    
    func sceneDidBecomeActive(_ scene: UIScene) {
        // Update background when scene becomes active
        window?.backgroundColor = UIColor(named: "Background")
    }
}

@main
struct iosApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
