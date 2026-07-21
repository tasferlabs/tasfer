package app.tasfer

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.BitmapFactory
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.Drawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Base64
import android.util.DisplayMetrics
import android.view.Gravity
import android.view.Menu
import android.view.View
import android.view.animation.Animation
import android.view.animation.LinearInterpolator
import android.view.animation.RotateAnimation
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.PopupMenu
import android.widget.RelativeLayout
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatDelegate
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.os.LocaleListCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import com.getcapacitor.BridgeActivity
import com.getcapacitor.WebViewListener
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

class MainActivity : BridgeActivity() {

    private companion object {
        /** How long a staged share payload is kept before it can be pruned. */
        const val SHARE_RETENTION_MS = 60 * 60 * 1000L
    }

    // Loading screen. Null when setupCustomViews found the content view in an
    // unexpected shape and bailed — every use site then simply has no overlay,
    // rather than the inset listener crashing on an unset lateinit.
    private var loadingScreen: View? = null

    // Off-main-thread work for bridge file/image I/O.
    private val backgroundExecutor: ExecutorService = Executors.newSingleThreadExecutor()

    // Safe area insets
    private var topInset = 0
    private var bottomInset = 0

    // Theme state
    private var isNightMode = false
    private var themeMode = "system"

    // Keyboard height tracking (px)
    private var lastKeyboardHeightPx = -1

    // Image picker
    private var currentPhotoUri: Uri? = null
    private lateinit var photoLibraryLauncher: ActivityResultLauncher<Intent>
    private lateinit var cameraLauncher: ActivityResultLauncher<Uri>
    private lateinit var cameraPermissionLauncher: ActivityResultLauncher<String>

    override fun onCreate(savedInstanceState: Bundle?) {
        setupImagePickerLaunchers()

        // System-SQLite database plugin (no SQLCipher). Must be registered
        // before super.onCreate() so the Capacitor bridge picks it up.
        registerPlugin(SqlitePlugin::class.java)

        super.onCreate(savedInstanceState)

        // Enable edge-to-edge display
        WindowCompat.setDecorFitsSystemWindows(window, false)

        isNightMode = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES

        setupCustomViews()
        setupWindowInsets()

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (bridge.webView.canGoBack()) {
                    bridge.webView.goBack()
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })
    }

    override fun onDestroy() {
        backgroundExecutor.shutdown()
        super.onDestroy()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        // When the activity's window regains focus (app foregrounded, or a system
        // sheet/permission dialog dismissed), the WebView is often left without
        // Android view focus. Because Chromium gates showing the soft keyboard on
        // the WebView holding view focus, a tap after foregrounding would focus the
        // hidden contenteditable but never raise the IME. Re-grant view focus so
        // Android's own keyboard logic runs on the next editable focus. This does
        // not itself show the keyboard — it only restores the precondition for it.
        if (hasFocus) {
            bridge?.webView?.post {
                bridge?.webView?.requestFocus()
            }
        }
    }

    override fun load() {
        super.load()

        // The interface is attached to the WebView, not to a page, so it gates every
        // call on the main frame's origin (see AndroidBridge.isTrustedCaller) using
        // the same rule set Capacitor gates its own bridge on. Seed it with the URL
        // we are about to load, then keep it current on every navigation below.
        val nativeBridge = AndroidBridge(this, bridge.webView, bridge.allowedOriginRules)
        nativeBridge.onNavigation(bridge.appUrl)
        bridge.webView.addJavascriptInterface(nativeBridge, "__NativeBridge")

        bridge.webView.isVerticalScrollBarEnabled = false
        bridge.webView.isHorizontalScrollBarEnabled = false

        // Let Android manage the soft keyboard on its own. Chromium only raises the
        // IME for a focused contenteditable when the WebView itself holds Android
        // *view* focus; JS `element.focus()` can't grant that. Making the WebView
        // focusable in touch mode means a tap on the canvas gives it view focus as
        // part of normal touch handling, so the editable focus that follows shows
        // the keyboard. Reparenting into the custom wrapper (setupCustomViews) can
        // leave these unset, which is why the first tap could focus text yet never
        // open the keyboard.
        bridge.webView.isFocusable = true
        bridge.webView.isFocusableInTouchMode = true

        bridge.addWebViewListener(object : WebViewListener() {
            // Track the main-frame origin from the earliest point a navigation is
            // visible, so the bridge is never open to a document that has already
            // started loading but not yet finished.
            override fun onPageStarted(webView: WebView) {
                nativeBridge.onNavigation(webView.url)
            }

            override fun onPageCommitVisible(view: WebView, url: String) {
                nativeBridge.onNavigation(url)
            }

            override fun onPageLoaded(webView: WebView) {
                nativeBridge.onNavigation(webView.url)
                injectTasferBridgeShim()
                hideLoadingScreen()
                injectSafeAreaInsets()
            }
        })
    }

    private fun setupCustomViews() {
        val rootLayout = findViewById<View>(android.R.id.content)
        val contentView = (rootLayout as? android.view.ViewGroup)?.getChildAt(0) as? android.view.ViewGroup
            ?: return

        val wrapper = RelativeLayout(this).apply {
            layoutParams = RelativeLayout.LayoutParams(
                RelativeLayout.LayoutParams.MATCH_PARENT,
                RelativeLayout.LayoutParams.MATCH_PARENT
            )
        }

        val existingViews = mutableListOf<View>()
        for (i in 0 until contentView.childCount) {
            existingViews.add(contentView.getChildAt(i))
        }
        contentView.removeAllViews()
        for (view in existingViews) {
            wrapper.addView(view)
        }

        val overlay = layoutInflater.inflate(R.layout.loading_screen, wrapper, false)
        wrapper.addView(overlay, RelativeLayout.LayoutParams(
            RelativeLayout.LayoutParams.MATCH_PARENT,
            RelativeLayout.LayoutParams.MATCH_PARENT
        ))

        contentView.addView(wrapper)

        loadingScreen = overlay
        startSpinnerAnimation(overlay.findViewById(R.id.spinnerImage))
    }

    // ---- Image picker ----

    private fun setupImagePickerLaunchers() {
        photoLibraryLauncher = registerForActivityResult(
            ActivityResultContracts.StartActivityForResult()
        ) { result ->
            if (result.resultCode == Activity.RESULT_OK) {
                result.data?.data?.let { uri ->
                    handleSelectedImage(uri)
                }
            }
        }

        cameraLauncher = registerForActivityResult(
            ActivityResultContracts.TakePicture()
        ) { success ->
            if (success && currentPhotoUri != null) {
                handleSelectedImage(currentPhotoUri!!)
            }
        }

        cameraPermissionLauncher = registerForActivityResult(
            ActivityResultContracts.RequestPermission()
        ) { isGranted ->
            if (isGranted) {
                launchCameraInternal()
            } else {
                Toast.makeText(this, getString(R.string.camera_permission_required), Toast.LENGTH_SHORT).show()
            }
        }
    }

    fun launchPhotoLibrary() {
        val intent = Intent(Intent.ACTION_PICK).apply {
            type = "image/*"
        }
        photoLibraryLauncher.launch(intent)
    }

    fun launchCamera() {
        when {
            ContextCompat.checkSelfPermission(
                this,
                Manifest.permission.CAMERA
            ) == PackageManager.PERMISSION_GRANTED -> {
                launchCameraInternal()
            }
            else -> {
                cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
            }
        }
    }

    private fun launchCameraInternal() {
        try {
            val photoFile = File.createTempFile(
                "JPEG_${System.currentTimeMillis()}_",
                ".jpg",
                cacheDir
            )

            currentPhotoUri = FileProvider.getUriForFile(
                this,
                "${applicationContext.packageName}.fileprovider",
                photoFile
            )

            cameraLauncher.launch(currentPhotoUri!!)
        } catch (_: IOException) {
            Toast.makeText(this, getString(R.string.camera_open_failed), Toast.LENGTH_SHORT).show()
        }
    }

    private fun handleSelectedImage(uri: Uri) {
        // Reading and base64-encoding a full-resolution photo is multi-megabyte
        // work, and this runs in the activity-result callback — i.e. on the main
        // thread — so doing it inline janks the UI and ANRs on large images.
        backgroundExecutor.execute {
            val dataUrl = try {
                contentResolver.openInputStream(uri)?.use { inputStream ->
                    val bytes = inputStream.readBytes()
                    val mimeType = contentResolver.getType(uri) ?: "image/jpeg"
                    "data:$mimeType;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP)
                }
            } catch (_: Exception) {
                null
            }

            runOnUiThread {
                if (dataUrl == null) {
                    Toast.makeText(this, getString(R.string.image_process_failed), Toast.LENGTH_SHORT).show()
                    return@runOnUiThread
                }
                // JSONObject.quote emits a fully escaped JS string literal. Escaping
                // only `'` by hand breaks on a backslash or newline in the MIME type.
                bridge.webView.evaluateJavascript(
                    "window.postMessage({type: 'native-image-selected', dataUrl: ${JSONObject.quote(dataUrl)}}, '*');",
                    null
                )
            }
        }
    }

    // ---- File sharing ----

    /** Staging dir for share-sheet payloads. */
    private val shareDir: File
        get() = File(cacheDir, "share").apply { mkdirs() }

    /**
     * Resolve [fileName] to a file directly inside [shareDir], or null when it
     * escapes.
     *
     * [fileName] crosses the bridge from JavaScript, so an unchecked
     * `File(cacheDir, fileName)` would let `../` segments reach anywhere under the
     * app's private data dir — the SQLite database included — and the write lands
     * before FileProvider would reject the path. Canonicalising both sides also
     * collapses symlinks. Same rule as AndroidBridge.resolveInStorage, tightened
     * to a single flat directory since share names are never nested.
     */
    private fun resolveShareFile(fileName: String): File? {
        return try {
            val base = shareDir.canonicalFile
            val target = File(base, fileName).canonicalFile
            if (target.parentFile == base) target else null
        } catch (_: Exception) {
            null
        }
    }

    /**
     * Drop payloads left behind by earlier exports — nothing else deletes them,
     * since the chooser gives no completion signal. Only entries old enough that
     * their share sheet cannot still be reading them are removed.
     */
    private fun pruneShareDir() {
        val cutoff = System.currentTimeMillis() - SHARE_RETENTION_MS
        try {
            shareDir.listFiles()?.forEach { file ->
                if (file.lastModified() < cutoff) file.deleteRecursively()
            }
        } catch (_: Exception) {
        }
    }

    fun shareFileData(bytes: ByteArray, fileName: String, mimeType: String): Boolean {
        return try {
            val file = resolveShareFile(fileName) ?: return false
            pruneShareDir()
            file.writeBytes(bytes)
            val uri = FileProvider.getUriForFile(this, "${applicationContext.packageName}.fileprovider", file)

            val intent = Intent(Intent.ACTION_SEND).apply {
                type = mimeType
                putExtra(Intent.EXTRA_STREAM, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }

            runOnUiThread {
                startActivity(Intent.createChooser(intent, null))
            }
            true
        } catch (_: Exception) {
            false
        }
    }

    // ---- TasferBridge JS shim ----

    private fun injectTasferBridgeShim() {
        val shimScript = """
            (function() {
                if (window.TasferBridge) return;
                var nb = window.__NativeBridge;
                if (!nb) return;
                window.TasferBridge = {
                    app: {
                        setLocale: function(tag) { nb.setLocale(tag); return Promise.resolve(); }
                    },
                    clipboard: {
                        copy: function(t) { nb.copy(t); return Promise.resolve(); },
                        cut: function(t) { nb.cut(t); return Promise.resolve(); },
                        paste: function() { return Promise.resolve(nb.paste() || ''); }
                    },
                    haptic: {
                        trigger: function(s) { nb.haptic(s); return Promise.resolve(); }
                    },
                    editor: {
                        setColorScheme: function(s) { nb.setColorScheme(s); return Promise.resolve(); },
                        showContextMenu: function(req) {
                            return new Promise(function(resolve) {
                                if (!window.__nativeContextMenuCallbacks) window.__nativeContextMenuCallbacks = new Map();
                                var id = 'ctx_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
                                window.__nativeContextMenuCallbacks.set(id, function(response) {
                                    window.__nativeContextMenuCallbacks.delete(id);
                                    resolve(response && response.id ? response.id : null);
                                });
                                nb.showContextMenu(JSON.stringify({ model: req.model, anchor: req.anchor }), id);
                            });
                        }
                    },
                    navigation: {
                        openUrl: function(u) { nb.openUrl(u); return Promise.resolve(); },
                        openPhotoLibrary: function() { nb.openPhotoLibrary(); return Promise.resolve(); },
                        openCamera: function() { nb.openCamera(); return Promise.resolve(); }
                    },
                    files: {
                        shareFile: function(d, n, m) { return Promise.resolve(nb.shareFile(d, n, m)); },
                        htmlToPdf: function(html) {
                            return new Promise(function(resolve, reject) {
                                if (!window.__nativePdfCallbacks) window.__nativePdfCallbacks = new Map();
                                var id = 'pdf_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
                                var timeout = setTimeout(function() {
                                    if (window.__nativePdfCallbacks.has(id)) {
                                        window.__nativePdfCallbacks.delete(id);
                                        reject(new Error('PDF render timed out'));
                                    }
                                }, 35000);
                                window.__nativePdfCallbacks.set(id, function(response) {
                                    clearTimeout(timeout);
                                    window.__nativePdfCallbacks.delete(id);
                                    if (response.error) reject(new Error(response.error));
                                    else resolve(response.result);
                                });
                                nb.htmlToPdf(html, id);
                            });
                        }
                    },
                    storage: {
                        write: function(p, d) { return Promise.resolve(nb.storageWrite(p, d)); },
                        read: function(p) { return Promise.resolve(nb.storageRead(p)); },
                        delete: function(p) { return Promise.resolve(nb.storageDelete(p)); },
                        list: function(p) { var j = nb.storageList(p); return Promise.resolve(JSON.parse(j)); },
                        exists: function(p) { return Promise.resolve(nb.storageExists(p)); },
                        getInfo: function() { var j = nb.getStorageInfo(); return Promise.resolve(JSON.parse(j)); }
                    }
                };
            })();
        """.trimIndent()
        bridge.webView.evaluateJavascript(shimScript, null)
    }

    // ---- Native context menu ----

    /**
     * Present a [PopupMenu] for the editor's long-press context menu. The model
     * mirrors the host's items (see web `app/nativeContextMenu.ts`); we resolve
     * the JS promise registered under [callbackId] with the chosen item id, or
     * null when dismissed without a selection. Runs on the UI thread.
     */
    // RtlHardcoded: the anchor gravity below is deliberately absolute — see the
    // comment at the call site. START is what breaks this in Arabic.
    @SuppressLint("RtlHardcoded")
    fun showNativeContextMenu(json: String, callbackId: String) {
        try {
            val root = JSONObject(json)
            val model = root.getJSONArray("model")
            val anchor = root.getJSONObject("anchor")

            // Anchor arrives as viewport-relative CSS pixels; scale to the
            // device-pixel coordinate space the view hierarchy uses.
            val density = resources.displayMetrics.density
            val anchorX = (anchor.optDouble("x", 0.0) * density).toInt()
            val anchorY = (anchor.optDouble("y", 0.0) * density).toInt()

            // PopupMenu anchors to a view, so place a 1x1 throwaway anchor at the
            // target point in the content frame and remove it on dismiss.
            val content = findViewById<FrameLayout>(android.R.id.content)
            val anchorView = View(this)
            anchorView.layoutParams = FrameLayout.LayoutParams(1, 1).apply {
                // Pin to an absolute LEFT gravity. FrameLayout's default child
                // gravity is TOP|START, which resolves to RIGHT under an RTL
                // locale (Arabic) — it then lays out from `rightMargin` and
                // ignores `leftMargin`, dropping the menu at the screen edge.
                // The anchor is in physical viewport pixels, so LEFT is correct
                // in both directions.
                gravity = Gravity.TOP or Gravity.LEFT
                leftMargin = anchorX
                topMargin = anchorY
            }
            content.addView(anchorView)

            val popup = PopupMenu(this, anchorView)
            // PopupMenu hides item icons by default; opt in (API 29+). Older
            // devices simply show a text-only menu.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                popup.setForceShowIcon(true)
            }
            val idByItemId = HashMap<Int, String>()
            buildContextMenu(popup.menu, model, idByItemId, 1)

            // `chosen` guards the dismiss handler from also resolving null after
            // an item was picked (click fires before the subsequent dismiss).
            var chosen = false
            popup.setOnMenuItemClickListener { item ->
                val id = idByItemId[item.itemId]
                if (id != null) {
                    chosen = true
                    resolveContextMenu(callbackId, id)
                }
                true
            }
            popup.setOnDismissListener {
                content.removeView(anchorView)
                if (!chosen) resolveContextMenu(callbackId, null)
            }
            popup.show()
        } catch (_: Exception) {
            // Never leave the web promise (and the engine's capture state) hanging.
            resolveContextMenu(callbackId, null)
        }
    }

    /** Populate [menu] from the serializable model, recursing into submenus. */
    private fun buildContextMenu(
        menu: Menu,
        items: JSONArray,
        idByItemId: HashMap<Int, String>,
        startId: Int,
    ): Int {
        var nextId = startId
        for (i in 0 until items.length()) {
            val item = items.optJSONObject(i) ?: continue
            val id = item.optString("id")
            val label = item.optString("label")
            val children = item.optJSONArray("children")

            if (children != null && children.length() > 0) {
                val submenu = menu.addSubMenu(label)
                submenu.item?.icon = decodeMenuIcon(item.optString("iconPng"))
                nextId = buildContextMenu(submenu, children, idByItemId, nextId)
                continue
            }

            val itemId = nextId++
            val menuItem = menu.add(Menu.NONE, itemId, Menu.NONE, label)
            idByItemId[itemId] = id
            menuItem.icon = decodeMenuIcon(item.optString("iconPng"))
            menuItem.isEnabled = item.optBoolean("enabled", true)
            if (item.optBoolean("checked", false)) {
                menuItem.isCheckable = true
                menuItem.isChecked = true
            }
        }
        return nextId
    }

    /**
     * Decode a `data:image/png;base64,...` URL (rasterized by the web side) into
     * a menu icon, or null when absent/unparseable. The bitmap density is pinned
     * to 2x so the 36px (2x of 18dp) PNG renders at a consistent ~18dp size on
     * any display.
     */
    private fun decodeMenuIcon(dataUrl: String?): Drawable? {
        if (dataUrl.isNullOrEmpty()) return null
        return try {
            val comma = dataUrl.indexOf(',')
            val base64 = if (comma >= 0) dataUrl.substring(comma + 1) else dataUrl
            val bytes = Base64.decode(base64, Base64.DEFAULT)
            val bitmap =
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return null
            bitmap.density = DisplayMetrics.DENSITY_DEFAULT * 2
            BitmapDrawable(resources, bitmap)
        } catch (_: Exception) {
            null
        }
    }

    /** Resolve the pending JS promise with [id] (or null) via the callback map. */
    private fun resolveContextMenu(callbackId: String, id: String?) {
        val payload = JSONObject().apply {
            put("id", id ?: JSONObject.NULL)
        }
        val js =
            "window.__nativeContextMenuCallbacks && window.__nativeContextMenuCallbacks.get('$callbackId') && window.__nativeContextMenuCallbacks.get('$callbackId')($payload)"
        bridge.webView.evaluateJavascript(js, null)
    }

    // ---- Safe area insets ----

    private fun injectSafeAreaInsets() {
        val density = resources.displayMetrics.density
        val topInsetDp = topInset / density
        val bottomInsetDp = bottomInset / density

        bridge.webView.evaluateJavascript("""
            (function() {
                if (document.documentElement) {
                    document.documentElement.style.setProperty('--safe-area-inset-top', '${topInsetDp}px');
                    document.documentElement.style.setProperty('--safe-area-inset-bottom', '${bottomInsetDp}px');
                    document.documentElement.style.setProperty('--safe-area-inset-left', '0px');
                    document.documentElement.style.setProperty('--safe-area-inset-right', '0px');
                }
            })();
        """.trimIndent(), null)
    }

    // ---- Window insets ----

    private fun setupWindowInsets() {
        val rootView = findViewById<View>(android.R.id.content)

        ViewCompat.setOnApplyWindowInsetsListener(rootView) { _, windowInsets ->
            val systemBars = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars())
            val ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime())

            topInset = systemBars.top
            bottomInset = systemBars.bottom

            injectSafeAreaInsets()

            val density = resources.displayMetrics.density

            val isKeyboardVisible = windowInsets.isVisible(WindowInsetsCompat.Type.ime())

            // Notify JS of soft keyboard height so the toolbar can be positioned correctly.
            // Use ime.bottom directly (not ime.bottom - bottomInset) because the WebView viewport
            // extends edge-to-edge to the bottom of the screen, so bottom:0 in CSS is below the
            // navigation bar. The full ime.bottom value is needed to clear both keyboard + nav bar.
            val keyboardHeightPx = if (isKeyboardVisible) maxOf(0, ime.bottom) else 0
            if (keyboardHeightPx != lastKeyboardHeightPx) {
                lastKeyboardHeightPx = keyboardHeightPx
                val keyboardHeightDp = keyboardHeightPx / density
                val isOpen = keyboardHeightPx > 0
                bridge.webView.post {
                    bridge.webView.evaluateJavascript(
                        "window.postMessage({type:'keyboard-height-changed',height:$keyboardHeightDp,isOpen:$isOpen},'*');",
                        null
                    )
                }
            }

            loadingScreen?.setPadding(0, topInset, 0, bottomInset)

            // Consume the insets so the framework doesn't propagate the IME inset
            // to the WebView and pan the document to reveal the focused
            // contenteditable when the keyboard opens/closes. We read everything we
            // need above and apply the loading-screen padding manually; no other
            // view has its own inset listener, so there's nothing downstream to
            // starve. The web layer compensates for the keyboard via the reported
            // height. (The app shell is also scroll-locked in CSS as a backstop.)
            WindowInsetsCompat.CONSUMED
        }
    }

    // ---- Loading screen ----

    private fun startSpinnerAnimation(spinnerImage: ImageView) {
        val rotateAnimation = RotateAnimation(
            0f, 360f,
            Animation.RELATIVE_TO_SELF, 0.5f,
            Animation.RELATIVE_TO_SELF, 0.5f
        ).apply {
            duration = 1000
            interpolator = LinearInterpolator()
            repeatCount = Animation.INFINITE
        }
        spinnerImage.startAnimation(rotateAnimation)
    }

    private fun hideLoadingScreen() {
        val overlay = loadingScreen ?: return
        overlay.animate()
            .alpha(0f)
            .setDuration(300)
            .withEndAction {
                overlay.visibility = View.GONE
            }
            .start()
    }

    // ---- Haptic feedback ----

    fun triggerHaptic(style: String) {
        val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val vibratorManager = getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager
            vibratorManager.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val effect = when (style) {
                "light" -> VibrationEffect.createOneShot(10, VibrationEffect.DEFAULT_AMPLITUDE)
                "medium" -> VibrationEffect.createOneShot(20, VibrationEffect.DEFAULT_AMPLITUDE)
                "heavy" -> VibrationEffect.createOneShot(50, VibrationEffect.DEFAULT_AMPLITUDE)
                else -> VibrationEffect.createOneShot(10, VibrationEffect.DEFAULT_AMPLITUDE)
            }
            vibrator.vibrate(effect)
        } else {
            @Suppress("DEPRECATION")
            val duration = when (style) {
                "light" -> 10L
                "medium" -> 20L
                "heavy" -> 50L
                else -> 10L
            }
            @Suppress("DEPRECATION")
            vibrator.vibrate(duration)
        }
    }

    // ---- Configuration changes ----

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)

        if (themeMode == "system") {
            val newNightMode = (newConfig.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
            if (newNightMode != isNightMode) {
                isNightMode = newNightMode
                loadingScreen?.setBackgroundColor(getThemeColor(R.color.light_background, R.color.dark_background))
                updateSystemBarsAppearance(isNightMode)
            }
        }
    }

    // ---- Locale management ----

    /**
     * Adopt an explicit in-app language choice as the app's locale, so natively
     * drawn text — the camera toasts, the permission prompt, the loading-screen
     * contentDescription — matches the WebView instead of following the device
     * language.
     *
     * Called only when the user picks a language. At startup the web layer
     * instead reads the stored choice back (`AndroidBridge.getLocale`), so the
     * AppCompat store — persisted below API 33 by the
     * `AppLocalesMetadataHolderService` in the manifest — is the single source
     * of truth and a stale web cache can never revert an OS-level per-app
     * choice.
     *
     * Re-applying the current locale is skipped: below API 33 AppCompat
     * delivers the change by recreating the activity.
     */
    fun onWebLocaleChanged(tag: String) {
        // A malformed tag parses to the empty list; applying that would clear
        // the stored choice, so it is dropped instead.
        if (!tag.matches(Regex("[A-Za-z0-9,-]{1,64}"))) return
        val requested = LocaleListCompat.forLanguageTags(tag)
        if (requested.isEmpty) return
        if (requested == AppCompatDelegate.getApplicationLocales()) return
        runOnUiThread {
            AppCompatDelegate.setApplicationLocales(requested)
        }
    }

    // ---- Theme management ----

    fun onWebThemeChanged(theme: String) {
        runOnUiThread {
            themeMode = theme
            isNightMode = when (theme) {
                "dark" -> true
                "light" -> false
                "system" -> {
                    val currentNightMode = resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK
                    currentNightMode == Configuration.UI_MODE_NIGHT_YES
                }
                else -> false
            }
            loadingScreen?.setBackgroundColor(getThemeColor(R.color.light_background, R.color.dark_background))
            updateSystemBarsAppearance(isNightMode)
        }
    }

    fun onWebColorSchemeChanged(colorScheme: String) {
        runOnUiThread {
            isNightMode = colorScheme == "dark"
            loadingScreen?.setBackgroundColor(getThemeColor(R.color.light_background, R.color.dark_background))
            updateSystemBarsAppearance(isNightMode)
        }
    }

    private fun updateSystemBarsAppearance(isDark: Boolean) {
        val windowInsetsController = WindowCompat.getInsetsController(window, window.decorView)
        windowInsetsController.isAppearanceLightStatusBars = !isDark
        windowInsetsController.isAppearanceLightNavigationBars = !isDark
    }

    private fun getThemeColor(lightColorRes: Int, darkColorRes: Int): Int {
        return getColor(if (isNightMode) darkColorRes else lightColorRes)
    }
}
