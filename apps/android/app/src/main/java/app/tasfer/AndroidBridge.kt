package app.tasfer

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.StatFs
import android.util.Base64
import android.util.Log
import android.view.inputmethod.InputMethodManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

class AndroidBridge(
    private val context: Context,
    private val webView: WebView,
    allowedOriginRules: Set<String>,
) {

    /**
     * Origins allowed to reach this interface, normalised to `scheme://authority`.
     * Seeded from the same rule set Capacitor gates its own bridge on (app scheme,
     * `server.url`, `server.allowNavigation`), so both bridges trust exactly the
     * same origins and there is one place to widen them.
     */
    private val allowedOrigins: Set<String> = allowedOriginRules.mapNotNull { originOf(it) }.toSet()

    /**
     * Origin of the document in the main frame. Written on the UI thread from the
     * navigation callbacks, read from the JavaScript-interface thread (WebView
     * dispatches @JavascriptInterface calls on its own thread), hence @Volatile.
     * Reading `webView.url` inside a bridge method instead would be an off-main
     * thread touch of the view.
     */
    @Volatile
    private var currentOrigin: String? = null

    /** Record a main-frame navigation. Must be called on the UI thread. */
    fun onNavigation(url: String?) {
        currentOrigin = originOf(url)
    }

    private fun originOf(url: String?): String? {
        if (url.isNullOrEmpty()) return null
        return try {
            val uri = Uri.parse(url)
            val scheme = uri.scheme?.lowercase() ?: return null
            val authority = uri.authority?.lowercase() ?: return null
            "$scheme://$authority"
        } catch (_: Exception) {
            null
        }
    }

    /**
     * Gate for every bridge method: the loaded document must be one of
     * [allowedOrigins]. The interface is attached to the WebView, not to a page,
     * so without this it answers whatever document happens to be loaded — handing
     * clipboard, camera, file storage and sharing to any page that gets in.
     *
     * Caveat: `addJavascriptInterface` injects into *every* frame and the platform
     * gives the callee no way to identify the calling frame, so this can only
     * check the main frame — a cross-origin iframe still passes. Closing that gap
     * means moving to `WebViewCompat.addWebMessageListener`, which enforces origin
     * and main-frame per message (what Capacitor's own MessageHandler does).
     */
    private fun isTrustedCaller(): Boolean {
        val origin = currentOrigin
        if (origin != null && allowedOrigins.contains(origin)) return true
        // Rejection is silent to the caller (methods return their empty value), so
        // log it — otherwise a misconfigured origin looks like a dead bridge.
        Log.w("TasferBridge", "Blocked __NativeBridge call from untrusted origin: $origin")
        return false
    }

    @JavascriptInterface
    fun copy(text: String) {
        if (!isTrustedCaller()) return
        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val clip = ClipData.newPlainText("Copied Text", text)
        clipboard.setPrimaryClip(clip)
    }

    @JavascriptInterface
    fun cut(text: String) {
        if (!isTrustedCaller()) return
        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val clip = ClipData.newPlainText("Cut Text", text)
        clipboard.setPrimaryClip(clip)
    }

    @JavascriptInterface
    fun paste(): String {
        if (!isTrustedCaller()) return ""
        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        return clipboard.primaryClip?.getItemAt(0)?.text?.toString() ?: ""
    }

    @JavascriptInterface
    fun haptic(style: String) {
        if (!isTrustedCaller()) return
        (context as? MainActivity)?.triggerHaptic(style)
    }

    @JavascriptInterface
    fun openPhotoLibrary() {
        if (!isTrustedCaller()) return
        (context as? MainActivity)?.runOnUiThread {
            (context as? MainActivity)?.launchPhotoLibrary()
        }
    }

    @JavascriptInterface
    fun openCamera() {
        if (!isTrustedCaller()) return
        (context as? MainActivity)?.runOnUiThread {
            (context as? MainActivity)?.launchCamera()
        }
    }

    @JavascriptInterface
    fun setTheme(theme: String) {
        if (!isTrustedCaller()) return
        (context as? MainActivity)?.onWebThemeChanged(theme)
    }

    @JavascriptInterface
    fun setColorScheme(colorScheme: String) {
        if (!isTrustedCaller()) return
        (context as? MainActivity)?.onWebColorSchemeChanged(colorScheme)
    }

    @JavascriptInterface
    fun dismissKeyboard() {
        if (!isTrustedCaller()) return
        (context as? MainActivity)?.runOnUiThread {
            val inputMethodManager =
                context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
            // The caller already blurred the contenteditable in JS, so the IME just
            // needs to be torn down. Do NOT clearFocus() the WebView here: with
            // adjustResize + edge-to-edge the WebView is the only focusable view, so
            // clearing its focus makes the framework immediately re-grant focus to
            // it, and Chromium re-shows the soft keyboard for its last-focused
            // editable — the keyboard closes briefly and then pops back up.
            inputMethodManager.hideSoftInputFromWindow(webView.windowToken, 0)
        }
    }

    @JavascriptInterface
    fun shareFile(base64Data: String, fileName: String, mimeType: String): Boolean {
        if (!isTrustedCaller()) return false
        return try {
            val bytes = Base64.decode(base64Data, Base64.NO_WRAP)
            (context as? MainActivity)?.shareFileData(bytes, fileName, mimeType) ?: false
        } catch (_: Exception) {
            false
        }
    }

    @JavascriptInterface
    fun htmlToPdf(html: String, callbackId: String) {
        if (!isTrustedCaller()) return
        val renderer = PdfRenderer(context)
        renderer.render(html) { bytes, err ->
            val payload = JSONObject()
            if (bytes != null) {
                payload.put("result", Base64.encodeToString(bytes, Base64.NO_WRAP))
            } else {
                payload.put("error", err ?: "Unknown error")
            }
            val js = "window.__nativePdfCallbacks && window.__nativePdfCallbacks.get('$callbackId') && window.__nativePdfCallbacks.get('$callbackId')($payload)"
            (context as? MainActivity)?.runOnUiThread {
                webView.evaluateJavascript(js, null)
            }
        }
    }

    @JavascriptInterface
    fun showContextMenu(json: String, callbackId: String) {
        if (!isTrustedCaller()) return
        // Built on the UI thread (PopupMenu touches the view hierarchy). The
        // chosen item id — or null on dismiss — comes back via the activity,
        // which resolves the JS promise registered under `callbackId`.
        (context as? MainActivity)?.runOnUiThread {
            (context as? MainActivity)?.showNativeContextMenu(json, callbackId)
        }
    }

    @JavascriptInterface
    fun openUrl(url: String) {
        if (!isTrustedCaller()) return
        // Web URLs only. The string comes from JavaScript, and ACTION_VIEW on an
        // arbitrary scheme (intent://, market://, a private deep link) would let a
        // page drive other apps on the device on the user's behalf. CATEGORY_BROWSABLE
        // further restricts the target to components that accept untrusted links.
        val uri = try {
            Uri.parse(url)
        } catch (_: Exception) {
            return
        }
        val scheme = uri.scheme?.lowercase()
        if (scheme != "http" && scheme != "https") return

        (context as? MainActivity)?.runOnUiThread {
            try {
                val intent = Intent(Intent.ACTION_VIEW, uri).apply {
                    addCategory(Intent.CATEGORY_BROWSABLE)
                }
                context.startActivity(intent)
            } catch (_: Exception) {
            }
        }
    }

    // Native storage methods
    private val storageBaseDir: File
        get() {
            val dir = File(context.filesDir, "tasfer")
            if (!dir.exists()) dir.mkdirs()
            return dir
        }

    /**
     * Resolve [path] inside the storage sandbox, or null when it escapes.
     *
     * [path] comes from JavaScript, so `..` segments would otherwise reach
     * anywhere under the app's private data dir — the SQLite database and
     * shared_prefs included, with [storageDelete] recursing. Canonicalising both
     * sides also collapses symlinks, so a link planted inside the sandbox cannot
     * redirect writes out of it.
     */
    private fun resolveInStorage(path: String): File? {
        return try {
            val base = storageBaseDir.canonicalFile
            val target = File(base, path).canonicalFile
            if (target == base || target.path.startsWith(base.path + File.separator)) {
                target
            } else {
                null
            }
        } catch (_: Exception) {
            null
        }
    }

    @JavascriptInterface
    fun storageWrite(path: String, base64Data: String): Boolean {
        if (!isTrustedCaller()) return false
        return try {
            val file = resolveInStorage(path) ?: return false
            file.parentFile?.mkdirs()
            val bytes = Base64.decode(base64Data, Base64.NO_WRAP)
            file.writeBytes(bytes)
            true
        } catch (_: Exception) {
            false
        }
    }

    @JavascriptInterface
    fun storageRead(path: String): String? {
        if (!isTrustedCaller()) return null
        return try {
            val file = resolveInStorage(path) ?: return null
            if (file.exists()) {
                Base64.encodeToString(file.readBytes(), Base64.NO_WRAP)
            } else {
                null
            }
        } catch (_: Exception) {
            null
        }
    }

    @JavascriptInterface
    fun storageDelete(path: String): Boolean {
        if (!isTrustedCaller()) return false
        return try {
            val file = resolveInStorage(path) ?: return false
            if (file.exists()) {
                file.deleteRecursively()
            } else {
                true
            }
        } catch (_: Exception) {
            false
        }
    }

    @JavascriptInterface
    fun storageList(path: String): String {
        if (!isTrustedCaller()) return "[]"
        return try {
            val dir = resolveInStorage(path) ?: return "[]"
            val files = if (dir.exists() && dir.isDirectory) {
                dir.listFiles()?.map { it.name } ?: emptyList()
            } else {
                emptyList()
            }
            JSONArray(files).toString()
        } catch (_: Exception) {
            "[]"
        }
    }

    @JavascriptInterface
    fun storageExists(path: String): Boolean {
        if (!isTrustedCaller()) return false
        return try {
            resolveInStorage(path)?.exists() ?: false
        } catch (_: Exception) {
            false
        }
    }

    @JavascriptInterface
    fun getStorageInfo(): String {
        if (!isTrustedCaller()) return """{"free":0,"total":0}"""
        return try {
            val stat = StatFs(context.filesDir.path)
            val free = stat.availableBytes
            val total = stat.totalBytes
            JSONObject().apply {
                put("free", free)
                put("total", total)
            }.toString()
        } catch (_: Exception) {
            """{"free":0,"total":0}"""
        }
    }
}
