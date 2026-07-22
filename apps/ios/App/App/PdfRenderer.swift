import UIKit
import WebKit

/// Renders an HTML string to PDF data using an offscreen WKWebView.
///
/// Holds itself alive (in `pendingRenderers`) until the load + PDF generation
/// completes, since callers don't keep a reference.
@available(iOS 14.0, *)
class PdfRenderer: NSObject, WKNavigationDelegate {
    // A4 in points (1pt = 1/72 inch): 595 x 842
    private static let pageSize = CGRect(x: 0, y: 0, width: 595, height: 842)

    private static var pendingRenderers = Set<PdfRenderer>()

    private var webView: WKWebView?
    private let completion: (Data?, String?) -> Void
    private var didFinish = false

    init(completion: @escaping (Data?, String?) -> Void) {
        self.completion = completion
    }

    func render(html: String) {
        DispatchQueue.main.async {
            let config = WKWebViewConfiguration()
            let wv = WKWebView(frame: PdfRenderer.pageSize, configuration: config)
            wv.navigationDelegate = self
            self.webView = wv
            PdfRenderer.pendingRenderers.insert(self)
            wv.loadHTMLString(html, baseURL: nil)

            // Safety timeout — if the load never finishes, fail after 30s
            DispatchQueue.main.asyncAfter(deadline: .now() + 30) { [weak self] in
                guard let self = self, !self.didFinish else { return }
                self.finish(data: nil, error: "PDF render timed out")
            }
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // Give layout/SVG/fonts a tick to settle before snapshotting
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in
            guard let self = self, !self.didFinish else { return }
            let pdfConfig = WKPDFConfiguration()
            webView.createPDF(configuration: pdfConfig) { result in
                switch result {
                case .success(let data):
                    self.finish(data: data, error: nil)
                case .failure(let err):
                    self.finish(data: nil, error: err.localizedDescription)
                }
            }
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        finish(data: nil, error: error.localizedDescription)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        finish(data: nil, error: error.localizedDescription)
    }

    private func finish(data: Data?, error: String?) {
        guard !didFinish else { return }
        didFinish = true
        completion(data, error)
        webView?.navigationDelegate = nil
        webView = nil
        PdfRenderer.pendingRenderers.remove(self)
    }
}
