package md.cypher.app

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Base64
import android.view.View
import android.view.animation.Animation
import android.view.animation.LinearInterpolator
import android.view.animation.RotateAnimation
import android.webkit.WebView
import android.widget.ImageView
import android.widget.RelativeLayout
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import com.getcapacitor.BridgeActivity
import com.getcapacitor.WebViewListener
import java.io.File
import java.io.IOException

class MainActivity : BridgeActivity() {

    // Loading screen
    private lateinit var loadingScreen: View
    private lateinit var spinnerImage: ImageView

    // Safe area insets
    private var topInset = 0
    private var bottomInset = 0

    // Theme state
    private var isNightMode = false
    private var themeMode = "system"

    // Physical keyboard detection
    private var hasPhysicalKeyboard = false

    // Keyboard height tracking (px)
    private var lastKeyboardHeightPx = -1

    // Image picker
    private var currentPhotoUri: Uri? = null
    private lateinit var photoLibraryLauncher: ActivityResultLauncher<Intent>
    private lateinit var cameraLauncher: ActivityResultLauncher<Uri>
    private lateinit var cameraPermissionLauncher: ActivityResultLauncher<String>

    override fun onCreate(savedInstanceState: Bundle?) {
        setupImagePickerLaunchers()

        super.onCreate(savedInstanceState)

        // Enable edge-to-edge display
        WindowCompat.setDecorFitsSystemWindows(window, false)

        isNightMode = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES

        setupCustomViews()
        setupWindowInsets()
        detectPhysicalKeyboard()

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

    override fun load() {
        super.load()

        bridge.webView.addJavascriptInterface(AndroidBridge(this, bridge.webView), "__NativeBridge")

        bridge.webView.isVerticalScrollBarEnabled = false
        bridge.webView.isHorizontalScrollBarEnabled = false

        bridge.addWebViewListener(object : WebViewListener() {
            override fun onPageLoaded(webView: WebView) {
                injectCypherBridgeShim()
                hideLoadingScreen()
                injectSafeAreaInsets()
                notifyPhysicalKeyboardState()
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

        loadingScreen = layoutInflater.inflate(R.layout.loading_screen, wrapper, false)
        wrapper.addView(loadingScreen, RelativeLayout.LayoutParams(
            RelativeLayout.LayoutParams.MATCH_PARENT,
            RelativeLayout.LayoutParams.MATCH_PARENT
        ))

        contentView.addView(wrapper)

        spinnerImage = loadingScreen.findViewById(R.id.spinnerImage)
        startSpinnerAnimation()
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
                Toast.makeText(this, "Camera permission is required to take photos", Toast.LENGTH_SHORT).show()
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
            Toast.makeText(this, "Failed to open camera", Toast.LENGTH_SHORT).show()
        }
    }

    private fun handleSelectedImage(uri: Uri) {
        try {
            contentResolver.openInputStream(uri)?.use { inputStream ->
                val bytes = inputStream.readBytes()
                val base64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
                val mimeType = contentResolver.getType(uri) ?: "image/jpeg"
                val dataUrl = "data:$mimeType;base64,$base64"

                bridge.webView.post {
                    val escapedData = dataUrl.replace("'", "\\'")
                    bridge.webView.evaluateJavascript(
                        "window.postMessage({type: 'native-image-selected', dataUrl: '$escapedData'}, '*');",
                        null
                    )
                }
            }
        } catch (_: Exception) {
            Toast.makeText(this, "Failed to process image", Toast.LENGTH_SHORT).show()
        }
    }

    // ---- File sharing ----

    fun shareFileData(bytes: ByteArray, fileName: String, mimeType: String): Boolean {
        return try {
            val file = File(cacheDir, fileName)
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

    // ---- CypherBridge JS shim ----

    private fun injectCypherBridgeShim() {
        val shimScript = """
            (function() {
                if (window.CypherBridge) return;
                var nb = window.__NativeBridge;
                if (!nb) return;
                window.CypherBridge = {
                    clipboard: {
                        copy: function(t) { nb.copy(t); return Promise.resolve(); },
                        cut: function(t) { nb.cut(t); return Promise.resolve(); },
                        paste: function() { return Promise.resolve(nb.paste() || ''); }
                    },
                    haptic: {
                        trigger: function(s) { nb.haptic(s); return Promise.resolve(); }
                    },
                    editor: {
                        setColorScheme: function(s) { nb.setColorScheme(s); return Promise.resolve(); }
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

            // Update physical keyboard heuristic from IME height
            val isKeyboardVisible = ime.bottom > bottomInset
            if (isKeyboardVisible) {
                val keyboardHeightDp = (ime.bottom - bottomInset) / density
                val isSoftKeyboard = keyboardHeightDp > 100
                if (isSoftKeyboard == hasPhysicalKeyboard) {
                    hasPhysicalKeyboard = !isSoftKeyboard
                    notifyPhysicalKeyboardState()
                }
            }

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

            loadingScreen.setPadding(0, topInset, 0, bottomInset)

            WindowInsetsCompat.CONSUMED
        }
    }

    // ---- Loading screen ----

    private fun startSpinnerAnimation() {
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
        loadingScreen.animate()
            .alpha(0f)
            .setDuration(300)
            .withEndAction {
                loadingScreen.visibility = View.GONE
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

    // ---- Physical keyboard detection ----

    private fun detectPhysicalKeyboard() {
        val config = resources.configuration
        // No op for now
        // hasPhysicalKeyboard = config.hardKeyboardHidden != Configuration.HARDKEYBOARDHIDDEN_YES &&
        //     config.hardKeyboardHidden != Configuration.HARDKEYBOARDHIDDEN_UNDEFINED
    }

    private fun notifyPhysicalKeyboardState() {
        bridge.webView.evaluateJavascript(
            "window.postMessage({type: 'physical-keyboard-connected', connected: $hasPhysicalKeyboard}, '*');",
            null
        )
    }

    // ---- Configuration changes ----

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        detectPhysicalKeyboard()

        if (themeMode == "system") {
            val newNightMode = (newConfig.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
            if (newNightMode != isNightMode) {
                isNightMode = newNightMode
                loadingScreen.setBackgroundColor(getThemeColor(R.color.light_background, R.color.dark_background))
                updateSystemBarsAppearance(isNightMode)
            }
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
            loadingScreen.setBackgroundColor(getThemeColor(R.color.light_background, R.color.dark_background))
            updateSystemBarsAppearance(isNightMode)
        }
    }

    fun onWebColorSchemeChanged(colorScheme: String) {
        runOnUiThread {
            isNightMode = colorScheme == "dark"
            loadingScreen.setBackgroundColor(getThemeColor(R.color.light_background, R.color.dark_background))
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
