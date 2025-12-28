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
            WebView(url: URL(string: "http://192.168.68.54:5173/")!, isLoading: $isLoading)
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
        default:
            break
        }
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
        userContentController.add(clipboardBridge, name: "clipboardBridge")
        
        configuration.userContentController = userContentController
        
        let webView = WKWebView(frame: .zero, configuration: configuration)
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
        webView.configuration.preferences.javaScriptEnabled = true
        
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
