package app.tasfer

import android.content.Context
import android.os.CancellationSignal
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.print.PageRange
import android.print.PrintAttributes
import android.print.PdfCallbacks
import android.print.PrintDocumentAdapter
import android.webkit.WebView
import android.webkit.WebViewClient
import java.io.File

/**
 * Renders an HTML string to a PDF byte array using an offscreen WebView and
 * its PrintDocumentAdapter. Result is delivered on the main thread.
 *
 * Caller does NOT need to keep a reference — the renderer pins itself via
 * the captured WebView until completion or timeout.
 */
class PdfRenderer(private val context: Context) {

    fun render(html: String, callback: (ByteArray?, String?) -> Unit) {
        Handler(Looper.getMainLooper()).post {
            try {
                renderInternal(html, callback)
            } catch (e: Exception) {
                callback(null, e.message ?: "Unknown error")
            }
        }
    }

    private fun renderInternal(html: String, callback: (ByteArray?, String?) -> Unit) {
        val webView = WebView(context)
        // Don't attach to a window — we only need the print adapter, which
        // builds its own pagination from the WebView's content.
        webView.settings.javaScriptEnabled = false
        webView.settings.loadWithOverviewMode = true

        var done = false
        val finish: (ByteArray?, String?) -> Unit = { bytes, err ->
            if (!done) {
                done = true
                callback(bytes, err)
                try { webView.destroy() } catch (_: Exception) {}
            }
        }

        // Safety timeout
        Handler(Looper.getMainLooper()).postDelayed({
            finish(null, "PDF render timed out")
        }, 30_000)

        webView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String) {
                // Give layout a moment to settle
                Handler(Looper.getMainLooper()).postDelayed({
                    if (done) return@postDelayed
                    runPrint(view, finish)
                }, 200)
            }
        }

        webView.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null)
    }

    private fun runPrint(webView: WebView, finish: (ByteArray?, String?) -> Unit) {
        val adapter = webView.createPrintDocumentAdapter("export")
        val attrs = PrintAttributes.Builder()
            .setMediaSize(PrintAttributes.MediaSize.ISO_A4)
            .setResolution(PrintAttributes.Resolution("pdf", "pdf", 600, 600))
            .setMinMargins(PrintAttributes.Margins.NO_MARGINS)
            .build()

        val outFile = File.createTempFile("tasfer_export_", ".pdf", context.cacheDir)
        val pfd = ParcelFileDescriptor.open(
            outFile,
            ParcelFileDescriptor.MODE_READ_WRITE or ParcelFileDescriptor.MODE_TRUNCATE,
        )

        adapter.onLayout(
            null,
            attrs,
            CancellationSignal(),
            object : PdfCallbacks.Layout() {
                override fun onLayoutFinished(info: android.print.PrintDocumentInfo, changed: Boolean) {
                    adapter.onWrite(
                        arrayOf(PageRange.ALL_PAGES),
                        pfd,
                        CancellationSignal(),
                        object : PdfCallbacks.Write() {
                            override fun onWriteFinished(pages: Array<out PageRange>?) {
                                try {
                                    pfd.close()
                                    val bytes = outFile.readBytes()
                                    outFile.delete()
                                    finish(bytes, null)
                                } catch (e: Exception) {
                                    finish(null, e.message ?: "Failed to read PDF")
                                }
                            }

                            override fun onWriteFailed(error: CharSequence?) {
                                try { pfd.close() } catch (_: Exception) {}
                                outFile.delete()
                                finish(null, error?.toString() ?: "PDF write failed")
                            }

                            override fun onWriteCancelled() {
                                try { pfd.close() } catch (_: Exception) {}
                                outFile.delete()
                                finish(null, "PDF write cancelled")
                            }
                        },
                    )
                }

                override fun onLayoutFailed(error: CharSequence?) {
                    try { pfd.close() } catch (_: Exception) {}
                    outFile.delete()
                    finish(null, error?.toString() ?: "PDF layout failed")
                }
            },
            null,
        )
    }
}
