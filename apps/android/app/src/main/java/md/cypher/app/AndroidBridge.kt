package md.cypher.app

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.StatFs
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

class AndroidBridge(private val context: Context, private val webView: WebView) {

    @JavascriptInterface
    fun copy(text: String) {
        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val clip = ClipData.newPlainText("Copied Text", text)
        clipboard.setPrimaryClip(clip)
    }

    @JavascriptInterface
    fun cut(text: String) {
        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val clip = ClipData.newPlainText("Cut Text", text)
        clipboard.setPrimaryClip(clip)
    }

    @JavascriptInterface
    fun paste(): String {
        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        return clipboard.primaryClip?.getItemAt(0)?.text?.toString() ?: ""
    }

    @JavascriptInterface
    fun updateUndoRedoState(canUndo: Boolean, canRedo: Boolean) {
        (context as? MainActivity)?.updateUndoRedoButtons(canUndo, canRedo)
    }

    @JavascriptInterface
    fun haptic(style: String) {
        (context as? MainActivity)?.triggerHaptic(style)
    }

    @JavascriptInterface
    fun setEditorFocused(focused: Boolean) {
        (context as? MainActivity)?.updateEditorFocus(focused)
    }

    @JavascriptInterface
    fun openPhotoLibrary() {
        (context as? MainActivity)?.runOnUiThread {
            (context as? MainActivity)?.launchPhotoLibrary()
        }
    }

    @JavascriptInterface
    fun openCamera() {
        (context as? MainActivity)?.runOnUiThread {
            (context as? MainActivity)?.launchCamera()
        }
    }

    @JavascriptInterface
    fun updateToolbarIcon(iconType: String) {
        (context as? MainActivity)?.updateToolbarIcon(iconType)
    }

    @JavascriptInterface
    fun updateFormattingState(isBold: Boolean, isItalic: Boolean, isCode: Boolean, isStrikethrough: Boolean) {
        (context as? MainActivity)?.updateFormattingState(isBold, isItalic, isCode, isStrikethrough)
    }

    @JavascriptInterface
    fun setTheme(theme: String) {
        (context as? MainActivity)?.onWebThemeChanged(theme)
    }

    @JavascriptInterface
    fun setColorScheme(colorScheme: String) {
        (context as? MainActivity)?.onWebColorSchemeChanged(colorScheme)
    }

    @JavascriptInterface
    fun openUrl(url: String) {
        (context as? MainActivity)?.runOnUiThread {
            try {
                val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
                context.startActivity(intent)
            } catch (_: Exception) {
            }
        }
    }

    // Native storage methods
    private val storageBaseDir: File
        get() {
            val dir = File(context.filesDir, "cypher")
            if (!dir.exists()) dir.mkdirs()
            return dir
        }

    @JavascriptInterface
    fun storageWrite(path: String, base64Data: String): Boolean {
        return try {
            val file = File(storageBaseDir, path)
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
        return try {
            val file = File(storageBaseDir, path)
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
        return try {
            val file = File(storageBaseDir, path)
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
        return try {
            val dir = File(storageBaseDir, path)
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
        return try {
            File(storageBaseDir, path).exists()
        } catch (_: Exception) {
            false
        }
    }

    @JavascriptInterface
    fun getStorageInfo(): String {
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
